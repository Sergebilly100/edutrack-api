import { sql } from 'drizzle-orm';
import type { TenantDb } from '../../shared/database/db.js';
import { confirmedSchoolStudent } from '../../shared/database/confirmed-school-membership.js';
import {
  getParentPortalMode,
  type ParentPortalMode,
} from '../../shared/auth/parent-eligibility.js';

export type ParentAccountsQueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

export type ParentProvisioningResult = {
  parentId: string;
  fullName: string;
  phone: string;
  created: boolean;
  temporaryPassword?: string;
};

export type TemporaryCredentials = {
  plainPassword: string;
  passwordHash: string;
};

type ParentIdentityRow = {
  id: string;
  full_name: string;
  phone: string;
  access_sent_at: Date | string | null;
};

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as { rows?: T[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

/**
 * Un seul parent principal (contact 1) a accès au portail d'un élève. Quand le
 * contact 1 change, les anciens liens créés par l'école (sans souscription) sont
 * supprimés : l'ancien parent perd l'accès à cet élève (le portail réévalue
 * l'éligibilité à chaque requête). Les liens portés par une souscription active
 * restent gérés depuis le menu abonnements.
 */
export const revokeStalePrimaryParentLinks = async (
  db: ParentAccountsQueryExecutor,
  studentId: string,
  primaryPhone: string | null
): Promise<number> => {
  const result = await db.execute(sql`
    DELETE FROM parent_student_links psl
    USING parents p
    WHERE p.id = psl.parent_id
      AND psl.student_id = ${studentId}::uuid
      AND psl.subscription_id IS NULL
      AND p.phone IS DISTINCT FROM ${primaryPhone}
    RETURNING psl.id
  `);
  return getRows<{ id: string }>(result).length;
};

/**
 * Crée (ou retrouve) le parent principal et garantit son lien avec l'élève.
 * Le téléphone est la clé de dédoublonnage tenant. Le mot de passe n'est
 * généré que lorsqu'aucun parent n'existe encore, ce qui évite de réinitialiser
 * les accès d'un parent déjà rattaché à un autre enfant.
 */
export const ensureParentAccountForStudent = async (
  db: ParentAccountsQueryExecutor,
  input: {
    studentId: string;
    fullName: string;
    phone: string;
    email?: string | null;
  },
  createCredentials: () => Promise<TemporaryCredentials>
): Promise<ParentProvisioningResult> => {
  const existingResult = await db.execute(sql`
    SELECT id::text AS id, full_name, phone, access_sent_at
    FROM parents
    WHERE phone = ${input.phone}
    LIMIT 1
  `);
  let parent = getRows<ParentIdentityRow>(existingResult)[0];
  let created = false;
  let temporaryPassword: string | undefined;

  if (!parent) {
    const credentials = await createCredentials();
    const insertedResult = await db.execute(sql`
      INSERT INTO parents (
        full_name,
        phone,
        email,
        password_hash,
        must_change_password,
        access_sent_at,
        is_active
      )
      VALUES (
        ${input.fullName},
        ${input.phone},
        ${input.email ?? null},
        ${credentials.passwordHash},
        true,
        NULL,
        true
      )
      ON CONFLICT (phone) DO NOTHING
      RETURNING id::text AS id, full_name, phone, access_sent_at
    `);

    parent = getRows<ParentIdentityRow>(insertedResult)[0];
    if (parent) {
      created = true;
      temporaryPassword = credentials.plainPassword;
    } else {
      // Une insertion concurrente a gagné le conflit d'unicité sur le téléphone.
      const concurrentResult = await db.execute(sql`
        SELECT id::text AS id, full_name, phone, access_sent_at
        FROM parents
        WHERE phone = ${input.phone}
        LIMIT 1
      `);
      parent = getRows<ParentIdentityRow>(concurrentResult)[0];
    }
  }

  if (!parent) {
    throw new Error('Unable to create or find parent account');
  }

  // Compte existant mais orphelin (aucun lien, ex. ancien contact 1 révoqué) :
  // aucun autre enfant n'est impacté, on renouvelle donc le mot de passe pour
  // que l'ancien secret ne serve jamais au nouveau parent principal.
  if (!created) {
    const linksResult = await db.execute(sql`
      SELECT 1 FROM parent_student_links WHERE parent_id = ${parent.id}::uuid LIMIT 1
    `);
    if (getRows<unknown>(linksResult).length === 0) {
      const credentials = await createCredentials();
      await db.execute(sql`
        UPDATE parents
        SET password_hash = ${credentials.passwordHash},
            must_change_password = true,
            access_sent_at = NULL
        WHERE id = ${parent.id}::uuid
      `);
      temporaryPassword = credentials.plainPassword;
      created = true;
    }
  }

  await db.execute(sql`
    INSERT INTO parent_student_links (subscription_id, parent_id, student_id)
    VALUES (NULL, ${parent.id}::uuid, ${input.studentId}::uuid)
    ON CONFLICT (parent_id, student_id) DO NOTHING
  `);

  return {
    parentId: parent.id,
    fullName: parent.full_name,
    phone: parent.phone,
    created,
    ...(temporaryPassword ? { temporaryPassword } : {}),
  };
};

export type ParentAccessRecord = {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  accessSentAt: string | null;
  accessPending: boolean;
};

export class ParentAccountsRepository {
  constructor(private readonly db: ParentAccountsQueryExecutor) {}

  getParentPortalMode(): Promise<ParentPortalMode> {
    return getParentPortalMode(this.db);
  }

  async getTenantSubdomain(schemaName: string): Promise<string | null> {
    const result = await this.db.execute(sql`
      SELECT subdomain FROM public.tenants WHERE schema_name = ${schemaName} LIMIT 1
    `);
    return getRows<{ subdomain: string }>(result)[0]?.subdomain ?? null;
  }

  async getPasswordHashForUpdate(parentId: string): Promise<string | null> {
    const result = await this.db.execute(sql`
      SELECT password_hash FROM parents WHERE id = ${parentId}::uuid FOR UPDATE
    `);
    return getRows<{ password_hash: string }>(result)[0]?.password_hash ?? null;
  }

  async transaction<T>(callback: (repository: ParentAccountsRepository) => Promise<T>): Promise<T> {
    return (this.db as TenantDb).transaction(async (tx) =>
      callback(new ParentAccountsRepository(tx as unknown as ParentAccountsQueryExecutor))
    );
  }

  async recordRotation(input: { parentId: string; phone: string; actorUserId: string | null; rotationId: string; action?: 'reset' | 'prepared' }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO notifications_log (type, channel, recipient_phone, message, status, related_id, metadata, created_at)
      VALUES ('parent_access_credentials', 'in_app', ${input.phone}, ${input.action === 'prepared' ? '[Accès parent préparé]' : '[Accès parent réinitialisé]'}, 'sent',
        ${input.parentId}::uuid, ${JSON.stringify({ actorUserId: input.actorUserId, rotationId: input.rotationId, action: input.action ?? 'reset' })}::jsonb,
        clock_timestamp())
    `);
  }

  async getRotationStatuses(parentId: string, rotationId: string): Promise<Array<{ channel: 'sms' | 'email'; status: string }>> {
    const result = await this.db.execute(sql`
      SELECT channel, status FROM notifications_log
      WHERE related_id = ${parentId}::uuid AND type = 'parent_access_credentials'
        AND metadata->>'rotationId' = ${rotationId} AND channel IN ('sms', 'email')
      ORDER BY CASE channel WHEN 'sms' THEN 0 ELSE 1 END
    `);
    return getRows<{ channel: 'sms' | 'email'; status: string }>(result);
  }

  async listByIds(parentIds: string[]): Promise<ParentAccessRecord[]> {
    if (parentIds.length === 0) return [];

    const result = await this.db.execute(sql`
      SELECT
        id::text AS id,
        full_name,
        phone,
        email,
        access_sent_at::text AS access_sent_at,
        EXISTS (
          SELECT 1
          FROM notifications_log n
          WHERE n.related_id = parents.id
            AND n.type = 'parent_access_credentials'
            AND n.status = 'queued'
            AND n.channel IN ('sms', 'email')
        ) AS access_pending
      FROM parents
      WHERE id IN (${sql.join(parentIds.map((id) => sql`${id}::uuid`), sql`, `)})
      ORDER BY created_at ASC
    `);

    return getRows<{
      id: string;
      full_name: string;
      phone: string;
      email: string | null;
      access_sent_at: string | null;
      access_pending: boolean;
    }>(result).map((row) => ({
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
      accessSentAt: row.access_sent_at,
      accessPending: row.access_pending,
    }));
  }

  async listByStudentId(studentId: string): Promise<ParentAccessRecord[]> {
    const result = await this.db.execute(sql`
      SELECT DISTINCT
        p.id::text AS id,
        p.full_name,
        p.phone,
        p.email,
        p.access_sent_at::text AS access_sent_at,
        EXISTS (
          SELECT 1
          FROM notifications_log n
          WHERE n.related_id = p.id
            AND n.type = 'parent_access_credentials'
            AND n.status = 'queued'
            AND n.channel IN ('sms', 'email')
        ) AS access_pending
      FROM parent_student_links psl
      INNER JOIN parents p ON p.id = psl.parent_id
      INNER JOIN students s ON s.id = psl.student_id
      INNER JOIN classes c
        ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      INNER JOIN school_years sy ON sy.id = c.school_year_id AND sy.status = 'active'
      WHERE psl.student_id = ${studentId}::uuid
        AND p.phone = s.parent_phone
        AND p.is_active = true
        AND s.is_active = true
        AND s.lifecycle_status = 'active'
      ORDER BY p.full_name ASC, p.phone ASC
    `);
    return getRows<{
      id: string;
      full_name: string;
      phone: string;
      email: string | null;
      access_sent_at: string | null;
      access_pending: boolean;
    }>(result).map((row) => ({
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
      accessSentAt: row.access_sent_at,
      accessPending: row.access_pending,
    }));
  }

  async listEligibleStudentParentIds(): Promise<string[]> {
    const result = await this.db.execute(sql`
      SELECT DISTINCT p.id::text AS id
      FROM parent_student_links psl
      INNER JOIN parents p ON p.id = psl.parent_id
      INNER JOIN students s ON s.id = psl.student_id
      INNER JOIN classes c
        ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      INNER JOIN school_years sy ON sy.id = c.school_year_id AND sy.status = 'active'
      WHERE p.phone = s.parent_phone
        AND p.is_active = true
        AND s.is_active = true
        AND s.lifecycle_status = 'active'
      ORDER BY 1
    `);
    return getRows<{ id: string }>(result).map((row) => row.id);
  }

  /**
   * Contact principal (contact 1) d'élèves confirmés dont le numéro n'est lié à
   * aucun compte parent. Seul le parent principal a un compte et accède au
   * portail : le contact 2 n'est jamais provisionné (il ne sert qu'aux alertes
   * lorsque le contact 1 est vide).
   */
  async listContactsWithoutParentLink(studentId?: string): Promise<Array<{
    studentId: string;
    fullName: string;
    phone: string;
    email: string | null;
  }>> {
    const result = await this.db.execute(sql`
      SELECT DISTINCT
        s.id::text AS student_id,
        COALESCE(NULLIF(BTRIM(s.parent_name), ''), 'Parent') AS full_name,
        s.parent_phone AS phone,
        s.parent_email AS email
      FROM students s
      INNER JOIN classes c
        ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      INNER JOIN school_years sy ON sy.id = c.school_year_id AND sy.status = 'active'
      WHERE s.is_active = true
        AND s.lifecycle_status = 'active'
        ${studentId ? sql`AND s.id = ${studentId}::uuid` : sql``}
        AND s.parent_phone ~ '^225[0-9]{10}$'
        AND NOT EXISTS (
          SELECT 1
          FROM parent_student_links psl
          INNER JOIN parents p ON p.id = psl.parent_id
          WHERE psl.student_id = s.id AND p.phone = s.parent_phone
        )
      ORDER BY 1
    `);
    return getRows<{
      student_id: string;
      full_name: string;
      phone: string;
      email: string | null;
    }>(result).map((row) => ({
      studentId: row.student_id,
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
    }));
  }

  ensureParentAccount(
    input: { studentId: string; fullName: string; phone: string; email?: string | null },
    createCredentials: () => Promise<TemporaryCredentials>
  ): Promise<ParentProvisioningResult> {
    return ensureParentAccountForStudent(this.db, input, createCredentials);
  }

  async isLinkedToConfirmedStudent(parentId: string, studentId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM parent_student_links psl
        INNER JOIN parents p ON p.id = psl.parent_id
        INNER JOIN students s ON s.id = psl.student_id
        INNER JOIN classes c
          ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
        INNER JOIN school_years sy ON sy.id = c.school_year_id AND sy.status = 'active'
        WHERE psl.parent_id = ${parentId}::uuid
          AND psl.student_id = ${studentId}::uuid
          AND p.phone = s.parent_phone
          AND p.is_active = true
          AND s.is_active = true
          AND s.lifecycle_status = 'active'
      ) AS allowed
    `);
    return getRows<{ allowed: boolean }>(result)[0]?.allowed ?? false;
  }

  async updateTemporaryPassword(parentId: string, passwordHash: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE parents
      SET
        password_hash = ${passwordHash},
        must_change_password = true,
        access_sent_at = NULL
      WHERE id = ${parentId}::uuid
    `);
  }

  async insertAccessNotification(input: {
    parentId: string;
    phone: string;
    email?: string | null;
    channel?: 'sms' | 'email';
    actorUserId?: string | null;
    rotationId?: string;
    queueRef: string;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO notifications_log (
        type,
        channel,
        recipient_phone,
        recipient_email,
        message,
        status,
        provider_ref,
        related_id,
        metadata
      )
      VALUES (
        'parent_access_credentials',
        ${input.channel ?? 'sms'},
        ${input.phone},
        ${input.email ?? null},
        '[Identifiants parent : envoi demandé]',
        'queued',
        ${input.queueRef},
        ${input.parentId}::uuid,
        ${JSON.stringify({ actorUserId: input.actorUserId ?? null, rotationId: input.rotationId ?? null })}::jsonb
      )
    `);
  }

}
