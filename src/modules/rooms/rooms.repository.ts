import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

import type { RoomEntity, RoomEntityRow, RoomStatsRow } from './rooms.types.js';
import { ensureTenantRealHoursInfrastructure } from '../../shared/database/real-hours-infrastructure.js';

export type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

type ActiveUsageRow = { has_active_schedule: boolean };

const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] => result.rows;

const toNumber = (value: string | number): number => {
  if (typeof value === 'number') {
    return value;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number value: ${value}`);
  }

  return parsed;
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
  // CRITIQUE: Conserver null au lieu de convertir en 0 (coordonnées 0,0 = Golfe de Guinée!)
  latitude: row.latitude === null ? null : toNumber(row.latitude),
  longitude: row.longitude === null ? null : toNumber(row.longitude),
  // geoRadius peut être null pour désactiver le géofencing
  geoRadius: row.geo_radius,
  isActive: row.is_active,
  createdAt: toIsoDateTime(row.created_at),
});

export class RoomsRepository {
  constructor(private readonly db: QueryExecutor) {}

  async listActiveRoomsWithStats(date: string): Promise<RoomStatsRow[]> {
    await ensureTenantRealHoursInfrastructure(this.db);

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
        r.latitude,
        r.longitude,
        r.geo_radius,
        r.is_active,
        r.created_at,
        COUNT(DISTINCT s.id) AS weekly_schedules_count,
        COUNT(DISTINCT at.id) FILTER (
          WHERE at.room_scan_start_at IS NOT NULL
            -- Filtrer les scans de la période active uniquement
            AND at.date >= (SELECT valid_from FROM active_period)
            AND at.date <= (SELECT valid_to FROM active_period)
        ) AS scans_count
      FROM rooms r
      LEFT JOIN active_period ap ON true
      LEFT JOIN schedules s
        ON s.room_id = r.id
       AND s.is_active = true
       AND (s.end_date IS NULL OR s.end_date > ${date}::date)
       AND s.schedule_period_id = ap.id
      LEFT JOIN attendances_teacher at
        ON at.room_scanned_id = r.id
      WHERE r.is_active = true
      GROUP BY r.id, r.name, r.building, r.capacity, r.latitude, r.longitude, r.geo_radius, r.is_active, r.created_at
      ORDER BY r.name ASC
    `);

    return getRows(result);
  }

  async createRoom(input: {
    name: string;
    qrToken: string;
    building?: string | null;
    capacity?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    geoRadius?: number | null;
  }): Promise<RoomEntity> {
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<RoomEntityRow>(sql`
      INSERT INTO rooms (name, qr_token, building, capacity, latitude, longitude, geo_radius, is_active)
      VALUES (
        ${input.name},
        ${input.qrToken},
        ${input.building ?? null},
        ${input.capacity ?? null},
        ${input.latitude ?? null}::numeric,
        ${input.longitude ?? null}::numeric,
        ${input.geoRadius ?? null},
        true
      )
      RETURNING id, name, qr_token, building, capacity, latitude, longitude, geo_radius, is_active, created_at
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
      latitude?: number | null;
      longitude?: number | null;
      geoRadius?: number | null;
    }
  ): Promise<RoomEntity | null> {
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<RoomEntityRow>(sql`
      UPDATE rooms
      SET
        name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
        building = CASE WHEN ${input.building !== undefined} THEN ${input.building ?? null} ELSE building END,
        capacity = CASE WHEN ${input.capacity !== undefined} THEN ${input.capacity ?? null}::integer ELSE capacity END,
        latitude = CASE WHEN ${input.latitude !== undefined} THEN ${input.latitude ?? null}::numeric ELSE latitude END,
        longitude = CASE WHEN ${input.longitude !== undefined} THEN ${input.longitude ?? null}::numeric ELSE longitude END,
        geo_radius = CASE WHEN ${input.geoRadius !== undefined} THEN ${input.geoRadius ?? null}::integer ELSE geo_radius END
      WHERE id = ${roomId}
      RETURNING id, name, qr_token, building, capacity, latitude, longitude, geo_radius, is_active, created_at
    `);

    const [row] = getRows(result);
    return row ? mapRoomEntity(row) : null;
  }

  async findRoomById(roomId: string): Promise<RoomEntity | null> {
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<RoomEntityRow>(sql`
      SELECT id, name, qr_token, building, capacity, latitude, longitude, geo_radius, is_active, created_at
      FROM rooms
      WHERE id = ${roomId}
      LIMIT 1
    `);

    const [row] = getRows(result);
    return row ? mapRoomEntity(row) : null;
  }

  async hasAnyActiveSchedules(roomId: string): Promise<boolean> {
    const result = await this.db.execute<ActiveUsageRow>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM schedules s
        WHERE s.room_id = ${roomId}
          AND s.is_active = true
          AND (s.end_date IS NULL OR s.end_date > CURRENT_DATE)
      ) AS has_active_schedule
    `);

    const [row] = getRows(result);
    return row?.has_active_schedule ?? false;
  }

  async softDeleteRoom(roomId: string): Promise<RoomEntity | null> {
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<RoomEntityRow>(sql`
      UPDATE rooms
      SET is_active = false
      WHERE id = ${roomId}
      RETURNING id, name, qr_token, building, capacity, latitude, longitude, geo_radius, is_active, created_at
    `);

    const [row] = getRows(result);
    return row ? mapRoomEntity(row) : null;
  }

  /**
   * Supprime (soft delete) une salle uniquement si elle n'est pas utilisée dans des créneaux actifs.
   * Cette opération est atomique via une sous-requête, évitant la race condition.
   *
   * @returns RoomEntity si suppression OK, null si room utilisée ou inexistante
   */
  async softDeleteRoomIfUnused(roomId: string): Promise<RoomEntity | null> {
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<RoomEntityRow>(sql`
      UPDATE rooms
      SET is_active = false
      WHERE id = ${roomId}
        AND NOT EXISTS (
          SELECT 1
          FROM schedules s
          WHERE s.room_id = ${roomId}
            AND s.is_active = true
            AND (s.end_date IS NULL OR s.end_date > CURRENT_DATE)
        )
      RETURNING id, name, qr_token, building, capacity, latitude, longitude, geo_radius, is_active, created_at
    `);

    const [row] = getRows(result);
    return row ? mapRoomEntity(row) : null;
  }

  async regenerateRoomToken(roomId: string, qrToken: string): Promise<RoomEntity | null> {
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<RoomEntityRow>(sql`
      UPDATE rooms
      SET qr_token = ${qrToken}
      WHERE id = ${roomId}
      RETURNING id, name, qr_token, building, capacity, latitude, longitude, geo_radius, is_active, created_at
    `);

    const [row] = getRows(result);
    return row ? mapRoomEntity(row) : null;
  }

  async findRoomByToken(qrToken: string): Promise<RoomEntity | null> {
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<RoomEntityRow>(sql`
      SELECT id, name, qr_token, building, capacity, latitude, longitude, geo_radius, is_active, created_at
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
  latitude: row.latitude === null ? null : toNumber(row.latitude),
  longitude: row.longitude === null ? null : toNumber(row.longitude),
  geoRadius: row.geo_radius, // null = géofencing désactivé
  isActive: row.is_active,
  createdAt: toIsoDateTime(row.created_at),
  stats: {
    weeklySchedulesCount: toNumber(row.weekly_schedules_count),
    scansCount: toNumber(row.scans_count),
  },
});
