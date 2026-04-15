import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

import type { RoomEntity, RoomEntityRow, RoomStatsRow } from './rooms.types.js';

export type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

type FutureUsageRow = { has_future_active_schedule: boolean };

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

const mapRoomEntity = (row: RoomEntityRow): RoomEntity => ({
  id: row.id,
  name: row.name,
  qrToken: row.qr_token,
  building: row.building,
  capacity: row.capacity,
  isActive: row.is_active,
  createdAt: toIsoDateTime(row.created_at),
});

export class RoomsRepository {
  constructor(private readonly db: QueryExecutor) {}

  async listActiveRoomsWithStats(date: string): Promise<RoomStatsRow[]> {
    const result = await this.db.execute<RoomStatsRow>(sql`
      WITH active_period AS (
        SELECT id
        FROM schedule_periods
        WHERE is_active = true
          AND valid_from <= ${date}
          AND valid_to >= ${date}
        ORDER BY created_at DESC
        LIMIT 1
      )
      SELECT
        r.id,
        r.name,
        r.building,
        r.capacity,
        r.is_active,
        r.created_at,
        COUNT(DISTINCT s.id) AS weekly_schedules_count,
        COUNT(DISTINCT at.id) FILTER (WHERE at.room_scan_start_at IS NOT NULL) AS scans_count
      FROM rooms r
      LEFT JOIN active_period ap ON true
      LEFT JOIN schedules s
        ON s.room_id = r.id
       AND s.is_active = true
       AND s.schedule_period_id = ap.id
      LEFT JOIN attendances_teacher at
        ON at.room_scanned_id = r.id
      WHERE r.is_active = true
      GROUP BY r.id, r.name, r.building, r.capacity, r.is_active, r.created_at
      ORDER BY r.name ASC
    `);

    return getRows(result);
  }

  async createRoom(input: {
    name: string;
    qrToken: string;
    building?: string | null;
    capacity?: number | null;
  }): Promise<RoomEntity> {
    const result = await this.db.execute<RoomEntityRow>(sql`
      INSERT INTO rooms (name, qr_token, building, capacity, is_active)
      VALUES (${input.name}, ${input.qrToken}, ${input.building ?? null}, ${input.capacity ?? null}, true)
      RETURNING id, name, qr_token, building, capacity, is_active, created_at
    `);

    const [row] = getRows(result);
    if (!row) {
      throw new Error('Failed to create room');
    }

    return mapRoomEntity(row);
  }

  async updateRoom(
    roomId: string,
    input: {
      name?: string;
      building?: string | null;
      capacity?: number | null;
    }
  ): Promise<RoomEntity | null> {
    const result = await this.db.execute<RoomEntityRow>(sql`
      UPDATE rooms
      SET
        name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
        building = CASE WHEN ${input.building !== undefined} THEN ${input.building ?? null} ELSE building END,
        capacity = CASE WHEN ${input.capacity !== undefined} THEN ${input.capacity ?? null}::integer ELSE capacity END
      WHERE id = ${roomId}
      RETURNING id, name, qr_token, building, capacity, is_active, created_at
    `);

    const [row] = getRows(result);
    return row ? mapRoomEntity(row) : null;
  }

  async findRoomById(roomId: string): Promise<RoomEntity | null> {
    const result = await this.db.execute<RoomEntityRow>(sql`
      SELECT id, name, qr_token, building, capacity, is_active, created_at
      FROM rooms
      WHERE id = ${roomId}
      LIMIT 1
    `);

    const [row] = getRows(result);
    return row ? mapRoomEntity(row) : null;
  }

  async hasFutureActiveSchedules(roomId: string, date: string): Promise<boolean> {
    const result = await this.db.execute<FutureUsageRow>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM schedules s
        INNER JOIN schedule_periods sp ON sp.id = s.schedule_period_id
        WHERE s.room_id = ${roomId}
          AND s.is_active = true
          AND sp.is_active = true
          AND sp.valid_to >= ${date}
      ) AS has_future_active_schedule
    `);

    const [row] = getRows(result);
    return row?.has_future_active_schedule ?? false;
  }

  async softDeleteRoom(roomId: string): Promise<RoomEntity | null> {
    const result = await this.db.execute<RoomEntityRow>(sql`
      UPDATE rooms
      SET is_active = false
      WHERE id = ${roomId}
      RETURNING id, name, qr_token, building, capacity, is_active, created_at
    `);

    const [row] = getRows(result);
    return row ? mapRoomEntity(row) : null;
  }

  async regenerateRoomToken(roomId: string, qrToken: string): Promise<RoomEntity | null> {
    const result = await this.db.execute<RoomEntityRow>(sql`
      UPDATE rooms
      SET qr_token = ${qrToken}
      WHERE id = ${roomId}
      RETURNING id, name, qr_token, building, capacity, is_active, created_at
    `);

    const [row] = getRows(result);
    return row ? mapRoomEntity(row) : null;
  }

  async findRoomByToken(qrToken: string): Promise<RoomEntity | null> {
    const result = await this.db.execute<RoomEntityRow>(sql`
      SELECT id, name, qr_token, building, capacity, is_active, created_at
      FROM rooms
      WHERE qr_token = ${qrToken}
      LIMIT 1
    `);

    const [row] = getRows(result);
    return row ? mapRoomEntity(row) : null;
  }
}

export const mapRoomStats = (row: RoomStatsRow) => ({
  id: row.id,
  name: row.name,
  building: row.building,
  capacity: row.capacity,
  isActive: row.is_active,
  createdAt: toIsoDateTime(row.created_at),
  stats: {
    weeklySchedulesCount: toNumber(row.weekly_schedules_count),
    scansCount: toNumber(row.scans_count),
  },
});
