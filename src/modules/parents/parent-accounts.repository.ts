import { sql } from 'drizzle-orm';
import type { TenantDb } from '../../shared/database/db.js';

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
};

export class ParentAccountsRepository {
  constructor(private readonly db: ParentAccountsQueryExecutor) {}

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
        access_sent_at::text AS access_sent_at
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
    }>(result).map((row) => ({
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
      accessSentAt: row.access_sent_at,
    }));
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
