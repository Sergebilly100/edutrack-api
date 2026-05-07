import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

const tenantSchemasReady = new Set<string>();
let publicReady = false;

const getRows = <TRow,>(result: unknown): TRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows: TRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

export const ensurePublicRealHoursInfrastructure = async (
  db: QueryExecutor
): Promise<void> => {
  if (publicReady) {
    return;
  }

  await db.execute(sql`
    ALTER TABLE public.school_sms_features
      ADD COLUMN IF NOT EXISTS use_real_hours boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS geo_check_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS checkout_tolerance_minutes integer NOT NULL DEFAULT 5
  `);

  await db.execute(sql`
    ALTER TABLE public.school_sms_features
      DROP CONSTRAINT IF EXISTS school_sms_features_checkout_tolerance_range_check
  `);

  await db.execute(sql`
    ALTER TABLE public.school_sms_features
      ADD CONSTRAINT school_sms_features_checkout_tolerance_range_check
      CHECK (checkout_tolerance_minutes >= 0 AND checkout_tolerance_minutes <= 30)
  `);

  publicReady = true;
};

export const ensureTenantRealHoursInfrastructure = async (
  db: QueryExecutor
): Promise<void> => {
  const schemaResult = await db.execute<{ schema_name: string }>(sql`
    SELECT current_schema() AS schema_name
  `);
  const schemaName = getRows<{ schema_name: string }>(schemaResult)[0]?.schema_name ?? 'tenant';

  await ensurePublicRealHoursInfrastructure(db);

  if (!tenantSchemasReady.has(schemaName)) {
    await db.execute(sql`
      DO $$ BEGIN
        CREATE TYPE attendance_validation_status AS ENUM (
          'not_required',
          'pending',
          'approved',
          'rejected'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await db.execute(sql.raw(`
      ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'qr_invalid_alert';
      ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'attendance_rejected';
    `));

    await db.execute(sql`
      ALTER TABLE attendances_teacher
        ADD COLUMN IF NOT EXISTS checked_out_at timestamptz,
        ADD COLUMN IF NOT EXISTS actual_minutes integer,
        ADD COLUMN IF NOT EXISTS checkin_latitude numeric(10,7),
        ADD COLUMN IF NOT EXISTS checkin_longitude numeric(10,7),
        ADD COLUMN IF NOT EXISTS checkin_accuracy numeric(6,2),
        ADD COLUMN IF NOT EXISTS checkin_distance numeric(8,2),
        ADD COLUMN IF NOT EXISTS geo_status text DEFAULT 'not_checked',
        ADD COLUMN IF NOT EXISTS checkout_latitude numeric(10,7),
        ADD COLUMN IF NOT EXISTS checkout_longitude numeric(10,7),
        ADD COLUMN IF NOT EXISTS checkout_accuracy numeric(6,2),
        ADD COLUMN IF NOT EXISTS checkout_geo_status text DEFAULT 'not_checked',
        ADD COLUMN IF NOT EXISTS validation_status attendance_validation_status NOT NULL DEFAULT 'not_required',
        ADD COLUMN IF NOT EXISTS validation_reason text,
        ADD COLUMN IF NOT EXISTS validated_by uuid,
        ADD COLUMN IF NOT EXISTS validated_at timestamptz,
        ADD COLUMN IF NOT EXISTS validated_hours numeric(5,2)
    `);

    await db.execute(sql`
      DO $$ BEGIN
        ALTER TABLE attendances_teacher
          ADD CONSTRAINT attendances_teacher_validated_by_users_id_fk
          FOREIGN KEY (validated_by) REFERENCES users(id)
          ON DELETE no action ON UPDATE no action;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await db.execute(sql`
      ALTER TABLE rooms
        ADD COLUMN IF NOT EXISTS latitude numeric(10,7),
        ADD COLUMN IF NOT EXISTS longitude numeric(10,7),
        ADD COLUMN IF NOT EXISTS geo_radius integer DEFAULT 100
    `);

    await db.execute(sql`
      ALTER TABLE notifications_log
        ADD COLUMN IF NOT EXISTS recipient_id uuid,
        ADD COLUMN IF NOT EXISTS metadata jsonb
    `);

    tenantSchemasReady.add(schemaName);
  }

  await db.execute(sql`
    CREATE OR REPLACE VIEW teacher_scan_compliance AS
    SELECT
      t.id AS teacher_id,
      u.name AS teacher_name,
      COUNT(at.id) FILTER (
        WHERE at.checked_in_at IS NOT NULL
          OR at.room_scan_start_at IS NOT NULL
          OR at.status IN ('present', 'late')
      )::int AS total_checkins,
      COUNT(at.id) FILTER (
        WHERE at.checked_out_at IS NOT NULL
          OR at.room_scan_end_at IS NOT NULL
      )::int AS total_checkouts,
      COALESCE(
        ROUND(
          COUNT(at.id) FILTER (
            WHERE at.checked_out_at IS NOT NULL
              OR at.room_scan_end_at IS NOT NULL
          )::numeric
          / NULLIF(
            COUNT(at.id) FILTER (
              WHERE at.checked_in_at IS NOT NULL
                OR at.room_scan_start_at IS NOT NULL
                OR at.status IN ('present', 'late')
            ),
            0
          ) * 100,
          1
        ),
        0
      ) AS compliance_rate,
      DATE_TRUNC('month', at.date)::date AS month
    FROM teachers t
    INNER JOIN users u ON u.id = t.user_id
    LEFT JOIN attendances_teacher at ON at.teacher_id = t.id
    GROUP BY t.id, u.name, DATE_TRUNC('month', at.date)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_att_teacher_compliance_teacher_created
      ON attendances_teacher (teacher_id, created_at)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_attendances_validation_status
      ON attendances_teacher (validation_status)
      WHERE validation_status = 'pending'
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_attendances_geo_status
      ON attendances_teacher (geo_status)
      WHERE geo_status = 'suspicious'
  `);

};
