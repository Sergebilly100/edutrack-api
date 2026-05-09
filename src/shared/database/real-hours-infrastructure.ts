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

    await db.execute(sql`DROP VIEW IF EXISTS teacher_scan_compliance`);
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
      -- Score scan de fin (30%)
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
      ) AS scan_end_rate,
      -- Score salle correcte (25%)
      COALESCE(
        ROUND(
          COUNT(at.id) FILTER (
            WHERE at.room_mismatch = false
              AND at.checked_in_at IS NOT NULL
          )::numeric
          / NULLIF(
            COUNT(at.id) FILTER (
              WHERE at.checked_in_at IS NOT NULL
            ),
            0
          ) * 100,
          1
        ),
        0
      ) AS room_correct_rate,
      -- Score pointage élèves (25%)
      COALESCE(
        ROUND(
          COUNT(DISTINCT (at.schedule_id, at.date)) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM attendances_student ast
              WHERE ast.schedule_id = at.schedule_id
                AND ast.date = at.date
            )
            AND at.checked_in_at IS NOT NULL
          )::numeric
          / NULLIF(
            COUNT(at.id) FILTER (
              WHERE at.checked_in_at IS NOT NULL
            ),
            0
          ) * 100,
          1
        ),
        0
      ) AS rollcall_rate,
      -- Score taux de présence (20%)
      COALESCE(
        ROUND(
          COUNT(at.id) FILTER (
            WHERE at.status IN ('present', 'late', 'excused')
          )::numeric
          / NULLIF(COUNT(s.id), 0) * 100,
          1
        ),
        0
      ) AS attendance_rate,
      -- Score composite pondéré
      COALESCE(
        ROUND(
          (
            -- Scan de fin : 30%
            COALESCE(
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
              ) * 30,
              0
            ) +
            -- Salle correcte : 25%
            COALESCE(
              COUNT(at.id) FILTER (
                WHERE at.room_mismatch = false
                  AND at.checked_in_at IS NOT NULL
              )::numeric
              / NULLIF(
                COUNT(at.id) FILTER (
                  WHERE at.checked_in_at IS NOT NULL
                ),
                0
              ) * 25,
              0
            ) +
            -- Pointage élèves : 25%
            COALESCE(
              COUNT(DISTINCT (at.schedule_id, at.date)) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM attendances_student ast
                  WHERE ast.schedule_id = at.schedule_id
                    AND ast.date = at.date
                )
                AND at.checked_in_at IS NOT NULL
              )::numeric
              / NULLIF(
                COUNT(at.id) FILTER (
                  WHERE at.checked_in_at IS NOT NULL
                ),
                0
              ) * 25,
              0
            ) +
            -- Taux de présence : 20%
            COALESCE(
              COUNT(at.id) FILTER (
                WHERE at.status IN ('present', 'late', 'excused')
              )::numeric
              / NULLIF(COUNT(s.id), 0) * 20,
              0
            )
          ),
          1
        ),
        0
      ) AS compliance_rate,
      DATE_TRUNC('month', at.date)::date AS month
    FROM teachers t
    INNER JOIN users u ON u.id = t.user_id
    LEFT JOIN schedules s ON s.teacher_id = t.id
    LEFT JOIN attendances_teacher at ON at.teacher_id = t.id
      AND at.schedule_id = s.id
      AND at.date >= DATE_TRUNC('month', CURRENT_DATE)
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

    tenantSchemasReady.add(schemaName);
  }
};
