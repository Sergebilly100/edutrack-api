-- Migration: Add CHECK constraint for actual_minutes validation
-- Date: 2026-05-10
-- Purpose: Prevent aberrant salary calculations by validating actual_minutes range (0-1440)

DO $$
BEGIN
  -- Add CHECK constraint to ensure actual_minutes is between 0 and 1440 (24 hours max)
  -- This prevents bugs where corrupted data (negative values, > 24h) cause incorrect salary calculations
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'att_teacher_actual_minutes_range'
      AND table_schema = 'tenant'
  ) THEN
    ALTER TABLE "tenant"."attendances_teacher"
    ADD CONSTRAINT att_teacher_actual_minutes_range
    CHECK (actual_minutes IS NULL OR (actual_minutes >= 0 AND actual_minutes <= 1440));

    RAISE NOTICE 'Added CHECK constraint: att_teacher_actual_minutes_range';
  END IF;

  -- Validate existing data: log rows that violate the constraint (for monitoring)
  -- This won't fail the migration, but will help identify corrupted data
  DECLARE
    invalid_count INTEGER;
  BEGIN
    SELECT COUNT(*)
    INTO invalid_count
    FROM "tenant"."attendances_teacher"
    WHERE actual_minutes IS NOT NULL
      AND (actual_minutes < 0 OR actual_minutes > 1440);

    IF invalid_count > 0 THEN
      RAISE WARNING '% existing rows have actual_minutes outside valid range (0-1440). These should be investigated.', invalid_count;
    END IF;
  END;
END $$;
