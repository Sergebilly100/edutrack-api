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
}
