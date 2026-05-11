import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

import type { PermissionKey } from '../../shared/types/index.js';

type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

type PositionRow = {
  id: string;
  name: string;
  permissions: PermissionKey[];
  created_by: string;
  created_at: Date | string;
};

type PositionListRow = PositionRow & {
  assignments_count: string | number;
};

type UserExistsRow = {
  exists: boolean;
};

type AssignmentCountRow = {
  count: string | number;
};

type SchoolConfigRow = {
  name: string;
  subdomain: string;
  plan: 'essential' | 'pro' | 'establishment';
  city: string | null;
  teaching_type: string | null;
  max_users: number;
  max_admin_positions: number;
  can_edit_sms_template: boolean;
  monetize_parent_alerts: boolean;
  allow_teacher_qr_skip: boolean;
  logo_url: string | null;
  active_school_year: string | null;
};

type AssignableUserRow = {
  id: string;
  name: string;
  role: 'director' | 'staff' | 'teacher' | 'super_admin';
  email: string | null;
  phone: string | null;
  created_at: Date | string;
  assigned_positions?: Array<{ id: string; name: string }> | null;
  position_names?: string[] | null;
  permissions?: string[] | null;
};

const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] => result.rows;

const toNumber = (value: string | number): number => {
  if (typeof value === 'number') {
    return value;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toIsoDateTime = (value: Date | string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
};

const mapPosition = (row: PositionListRow) => ({
  id: row.id,
  name: row.name,
  permissions: row.permissions,
  createdBy: row.created_by,
  createdAt: toIsoDateTime(row.created_at),
  assignmentsCount: toNumber(row.assignments_count),
});

export class PermissionsRepository {
  constructor(private readonly db: QueryExecutor) {}

  async countActiveUsers(): Promise<number> {
    const result = await this.db.execute<AssignmentCountRow>(sql`
      SELECT COUNT(*)::int AS count
      FROM users
      WHERE is_active = true
    `);

    const [row] = getRows(result);
    return row ? toNumber(row.count) : 0;
  }

  async countActiveAdministrativeUsers(): Promise<number> {
    const result = await this.db.execute<AssignmentCountRow>(sql`
      SELECT COUNT(*)::int AS count
      FROM users
      WHERE is_active = true
        AND role::text IN ('secretary', 'staff')
    `);

    const [row] = getRows(result);
    return row ? toNumber(row.count) : 0;
  }

  async listPositions(): Promise<Array<ReturnType<typeof mapPosition>>> {
    const result = await this.db.execute<PositionListRow>(sql`
      SELECT
        ap.id,
        ap.name,
        ap.permissions,
        ap.created_by,
        ap.created_at,
        COUNT(pa.id)::int AS assignments_count
      FROM admin_positions ap
      LEFT JOIN position_assignments pa ON pa.position_id = ap.id
      GROUP BY ap.id, ap.name, ap.permissions, ap.created_by, ap.created_at
      ORDER BY ap.name ASC
    `);

    return getRows(result).map(mapPosition);
  }

  async getSchoolConfigBySchemaName(schemaName: string): Promise<SchoolConfigRow | null> {
    // Columns logo_url, active_school_year, allow_teacher_qr_skip are guaranteed by the boot migration
    const result = await this.db.execute<SchoolConfigRow>(sql`
      SELECT
        tenants.name,
        tenants.subdomain,
        tenants.plan,
        tenants.city,
        tenants.teaching_type,
        tenants.max_users,
        tenants.max_admin_positions,
        COALESCE(tenants.can_edit_sms_template, false) AS can_edit_sms_template,
        COALESCE(features.monetize_parent_alerts, false) AS monetize_parent_alerts,
        COALESCE(tenants.allow_teacher_qr_skip, false) AS allow_teacher_qr_skip,
        tenants.logo_url,
        tenants.active_school_year
      FROM public.tenants tenants
      LEFT JOIN public.school_sms_features features ON features.tenant_id = tenants.id
      WHERE tenants.schema_name = ${schemaName}
      LIMIT 1
    `);

    const [row] = getRows(result);
    return row ?? null;
  }

  async findPositionById(positionId: string): Promise<ReturnType<typeof mapPosition> | null> {
    const result = await this.db.execute<PositionListRow>(sql`
      SELECT
        ap.id,
        ap.name,
        ap.permissions,
        ap.created_by,
        ap.created_at,
        COUNT(pa.id)::int AS assignments_count
      FROM admin_positions ap
      LEFT JOIN position_assignments pa ON pa.position_id = ap.id
      WHERE ap.id = ${positionId}
      GROUP BY ap.id, ap.name, ap.permissions, ap.created_by, ap.created_at
      LIMIT 1
    `);

    const [row] = getRows(result);
    return row ? mapPosition(row) : null;
  }

  async createPosition(input: {
    name: string;
    permissions: PermissionKey[];
    createdBy: string;
  }): Promise<ReturnType<typeof mapPosition>> {
    const result = await this.db.execute<PositionListRow>(sql`
      INSERT INTO admin_positions (name, permissions, created_by)
      VALUES (${input.name}, ${JSON.stringify(input.permissions)}::jsonb, ${input.createdBy})
      RETURNING id, name, permissions, created_by, created_at, 0::int AS assignments_count
    `);

    const [row] = getRows(result);
    if (!row) {
      throw new Error('Failed to create position');
    }

    return mapPosition(row);
  }

  async updatePosition(
    positionId: string,
    input: {
      name?: string;
      permissions?: PermissionKey[];
    }
  ): Promise<ReturnType<typeof mapPosition> | null> {
    const result = await this.db.execute<PositionListRow>(sql`
      WITH updated AS (
        UPDATE admin_positions
        SET
          name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
          permissions = CASE
            WHEN ${input.permissions !== undefined}
              THEN ${JSON.stringify(input.permissions ?? [])}::jsonb
            ELSE permissions
          END
        WHERE id = ${positionId}
        RETURNING id, name, permissions, created_by, created_at
      )
      SELECT
        u.id,
        u.name,
        u.permissions,
        u.created_by,
        u.created_at,
        (
          SELECT COUNT(pa.id)::int
          FROM position_assignments pa
          WHERE pa.position_id = u.id
        ) AS assignments_count
      FROM updated u
    `);

    const [row] = getRows(result);
    return row ? mapPosition(row) : null;
  }

  async deletePosition(positionId: string): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      DELETE FROM admin_positions
      WHERE id = ${positionId}
      RETURNING id
    `);

    return getRows(result).length > 0;
  }

  async countAssignments(positionId: string): Promise<number> {
    const result = await this.db.execute<AssignmentCountRow>(sql`
      SELECT COUNT(*)::int AS count
      FROM position_assignments
      WHERE position_id = ${positionId}
    `);

    const [row] = getRows(result);
    return row ? toNumber(row.count) : 0;
  }

  async userExists(userId: string): Promise<boolean> {
    const result = await this.db.execute<UserExistsRow>(sql`
      SELECT EXISTS (SELECT 1 FROM users WHERE id = ${userId}) AS exists
    `);

    const [row] = getRows(result);
    return row?.exists ?? false;
  }

  async canReceivePositionAssignment(userId: string): Promise<boolean> {
    const result = await this.db.execute<UserExistsRow>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM users
        WHERE id = ${userId}
          AND role::text IN ('secretary', 'staff')
          AND is_active = true
      ) AS exists
    `);

    const [row] = getRows(result);
    return row?.exists ?? false;
  }

  async assignPosition(input: {
    userId: string;
    positionId: string;
    assignedBy: string;
  }): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      INSERT INTO position_assignments (user_id, position_id, assigned_by)
      VALUES (${input.userId}, ${input.positionId}, ${input.assignedBy})
      ON CONFLICT (user_id, position_id) DO NOTHING
      RETURNING id
    `);

    return getRows(result).length > 0;
  }

  async unassignPosition(positionId: string, userId: string): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      DELETE FROM position_assignments
      WHERE position_id = ${positionId}
        AND user_id = ${userId}
      RETURNING id
    `);

    return getRows(result).length > 0;
  }

  async listAssignedPermissions(userId: string): Promise<PermissionKey[]> {
    const result = await this.db.execute<{ permission: string }>(sql`
      SELECT DISTINCT jsonb_array_elements_text(ap.permissions) AS permission
      FROM position_assignments pa
      INNER JOIN admin_positions ap ON ap.id = pa.position_id
      WHERE pa.user_id = ${userId}
    `);

    return getRows(result).map((row) => row.permission as PermissionKey);
  }

  async listAdministrativeUsers(): Promise<
    Array<{
      id: string;
      name: string;
      role: string;
      email: string | null;
      phone: string | null;
      assignedPositions: Array<{ id: string; name: string }>;
      positions: string[];
      permissions: string[];
    }>
  > {
    const result = await this.db.execute<AssignableUserRow>(sql`
      SELECT
        u.id,
        u.name,
        u.role,
        u.email,
        u.phone,
        u.created_at,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('id', ap.id, 'name', ap.name))
            FILTER (WHERE ap.id IS NOT NULL),
          '[]'::jsonb
        ) AS assigned_positions,
        COALESCE(array_remove(array_agg(DISTINCT ap.name), NULL), ARRAY[]::text[]) AS position_names,
        COALESCE(array_remove(array_agg(DISTINCT perm.permission), NULL), ARRAY[]::text[]) AS permissions
      FROM users u
      LEFT JOIN position_assignments pa ON pa.user_id = u.id
      LEFT JOIN admin_positions ap ON ap.id = pa.position_id
      LEFT JOIN LATERAL jsonb_array_elements_text(ap.permissions) AS perm(permission) ON true
      WHERE u.role::text IN ('secretary', 'staff')
        AND u.is_active = true
      GROUP BY u.id, u.name, u.role, u.email, u.phone, u.created_at
      ORDER BY u.created_at DESC
    `);

    return getRows(result).map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      email: row.email,
      phone: row.phone,
      assignedPositions: Array.isArray(row.assigned_positions) ? row.assigned_positions : [],
      positions: Array.isArray(row.position_names) ? row.position_names : [],
      permissions: Array.isArray(row.permissions) ? row.permissions : [],
    }));
  }

  async createAdministrativeUser(input: {
    name: string;
    email: string | null;
    phone: string | null;
    passwordHash: string;
  }): Promise<{
    id: string;
    name: string;
    role: string;
    email: string | null;
    phone: string | null;
  }> {
    const result = await this.db.execute<AssignableUserRow>(sql`
      INSERT INTO users (role, name, phone, email, password_hash, is_active)
      VALUES ('staff', ${input.name}, ${input.phone}, ${input.email}, ${input.passwordHash}, true)
      RETURNING id, name, role, email, phone, created_at
    `);

    const [row] = getRows(result);
    if (!row) {
      throw new Error('Failed to create administrative user');
    }

    return {
      id: row.id,
      name: row.name,
      role: row.role,
      email: row.email,
      phone: row.phone,
    };
  }

  async reactivateInactiveAdministrativeUserByContact(input: {
    name: string;
    email: string | null;
    phone: string | null;
    passwordHash: string;
  }): Promise<{
    id: string;
    name: string;
    role: string;
    email: string | null;
    phone: string | null;
  } | null> {
    const result = await this.db.execute<AssignableUserRow>(sql`
      WITH candidate AS (
        SELECT id
        FROM users
        WHERE role::text IN ('secretary', 'staff')
          AND is_active = false
          AND (
            (${input.email}::text IS NOT NULL AND email = ${input.email})
            OR
            (${input.phone}::text IS NOT NULL AND phone = ${input.phone})
          )
        ORDER BY created_at DESC
        LIMIT 1
      ),
      cleaned_assignments AS (
        DELETE FROM position_assignments
        WHERE user_id IN (SELECT id FROM candidate)
      )
      UPDATE users u
      SET
        name = ${input.name},
        email = ${input.email},
        phone = ${input.phone},
        password_hash = ${input.passwordHash},
        is_active = true
      FROM candidate
      WHERE u.id = candidate.id
      RETURNING u.id, u.name, u.role, u.email, u.phone, u.created_at
    `);

    const [row] = getRows(result);
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      role: row.role,
      email: row.email,
      phone: row.phone,
    };
  }

  async findAdministrativeUserById(userId: string): Promise<{
    id: string;
    name: string;
    role: string;
    email: string | null;
    phone: string | null;
  } | null> {
    const result = await this.db.execute<AssignableUserRow>(sql`
      SELECT id, name, role, email, phone, created_at
      FROM users
      WHERE id = ${userId}
        AND role::text IN ('secretary', 'staff')
        AND is_active = true
      LIMIT 1
    `);

    const [row] = getRows(result);
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      role: row.role,
      email: row.email,
      phone: row.phone,
    };
  }

  async updateAdministrativeUser(
    userId: string,
    input: {
      name?: string;
      email?: string | null;
      phone?: string | null;
    }
  ): Promise<{
    id: string;
    name: string;
    role: string;
    email: string | null;
    phone: string | null;
  } | null> {
    const result = await this.db.execute<AssignableUserRow>(sql`
      UPDATE users
      SET
        name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
        email = CASE WHEN ${input.email !== undefined} THEN ${input.email ?? null} ELSE email END,
        phone = CASE WHEN ${input.phone !== undefined} THEN ${input.phone ?? null} ELSE phone END
      WHERE id = ${userId}
        AND role::text IN ('secretary', 'staff')
        AND is_active = true
      RETURNING id, name, role, email, phone, created_at
    `);

    const [row] = getRows(result);
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      role: row.role,
      email: row.email,
      phone: row.phone,
    };
  }

  async deactivateAdministrativeUser(userId: string): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      WITH removed_assignments AS (
        DELETE FROM position_assignments
        WHERE user_id = ${userId}
      )
      UPDATE users
      SET is_active = false
      WHERE id = ${userId}
        AND role::text IN ('secretary', 'staff')
        AND is_active = true
      RETURNING id
    `);

    return getRows(result).length > 0;
  }

  async updateAdministrativeUserPasswordHash(
    userId: string,
    passwordHash: string
  ): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE users
      SET password_hash = ${passwordHash}
      WHERE id = ${userId}
        AND role::text IN ('secretary', 'staff')
        AND is_active = true
      RETURNING id
    `);

    return getRows(result).length > 0;
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    try {
      await this.db.execute(sql`
        UPDATE refresh_tokens
        SET is_active = false,
            updated_at = NOW(),
            revoked_at = NOW()
        WHERE user_id = ${userId}::uuid
          AND is_active = true
      `);
    } catch {
      // refresh_tokens table may not exist on all tenants — fail silently.
    }
  }

  async updateSchoolConfig(
    schemaName: string,
    input: {
      name?: string;
      city?: string;
      teachingType?: string;
      logoUrl?: string | null;
      activeSchoolYear?: string | null;
      allowTeacherQrSkip?: boolean;
    }
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE public.tenants
      SET
        name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
        city = CASE WHEN ${input.city !== undefined} THEN ${input.city ?? null} ELSE city END,
        teaching_type = CASE
          WHEN ${input.teachingType !== undefined}
            THEN ${input.teachingType ?? null}
          ELSE teaching_type
        END,
        logo_url = CASE WHEN ${input.logoUrl !== undefined} THEN ${input.logoUrl ?? null} ELSE logo_url END,
        active_school_year = CASE
          WHEN ${input.activeSchoolYear !== undefined}
            THEN ${input.activeSchoolYear ?? null}
          ELSE active_school_year
        END,
        allow_teacher_qr_skip = CASE
          WHEN ${input.allowTeacherQrSkip !== undefined}
            THEN ${input.allowTeacherQrSkip ?? false}
          ELSE allow_teacher_qr_skip
        END,
        updated_at = NOW()
      WHERE schema_name = ${schemaName}
    `);
  }

  async updateMaxAdminPositions(schemaName: string, maxAdminPositions: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE public.tenants
      SET max_admin_positions = ${maxAdminPositions}, updated_at = NOW()
      WHERE schema_name = ${schemaName}
    `);
  }
}
