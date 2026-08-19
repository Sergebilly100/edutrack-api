DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '"tenant"."tuition_plans"'::regclass AND attname = 'level_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE "tenant"."tuition_plans" ADD COLUMN "level_id" uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '"tenant"."tuition_plans"'::regclass AND attname = 'school_year_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE "tenant"."tuition_plans" ADD COLUMN "school_year_id" uuid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '"tenant"."tuition_plans"'::regclass AND attname = 'class_id' AND NOT attisdropped
  ) THEN
    UPDATE "tenant"."tuition_plans" tp
    SET level_id = c.level_id,
        school_year_id = c.school_year_id
    FROM "tenant"."classes" c
    WHERE c.id = tp.class_id
      AND (tp.level_id IS NULL OR tp.school_year_id IS NULL);

    IF EXISTS (
      SELECT 1
      FROM (
        SELECT tp.level_id, tp.school_year_id,
               COUNT(DISTINCT jsonb_build_object(
                 'total', tp.total_amount,
                 'currency', tp.currency,
                 'steps', COALESCE((
                   SELECT jsonb_agg(jsonb_build_array(tss.due_date, tss.cumulative_amount_expected) ORDER BY tss.due_date)
                   FROM "tenant"."tuition_schedule_steps" tss
                   WHERE tss.tuition_plan_id = tp.id
                 ), '[]'::jsonb)
               )) AS variants
        FROM "tenant"."tuition_plans" tp
        GROUP BY tp.level_id, tp.school_year_id
      ) grouped_plans
      WHERE grouped_plans.variants > 1
    ) THEN
      RAISE EXCEPTION 'Conflicting class tuition plans exist for the same level and school year; reconcile them before migration';
    END IF;

    DELETE FROM "tenant"."tuition_plans" tp
    USING (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY level_id, school_year_id ORDER BY created_at ASC, id ASC
      ) AS row_number
      FROM "tenant"."tuition_plans"
    ) duplicates
    WHERE tp.id = duplicates.id AND duplicates.row_number > 1;

    ALTER TABLE "tenant"."tuition_plans" DROP CONSTRAINT IF EXISTS "tuition_plans_class_unique";
    ALTER TABLE "tenant"."tuition_plans" DROP CONSTRAINT IF EXISTS "tuition_plans_class_id_classes_id_fk";
    ALTER TABLE "tenant"."tuition_plans" DROP COLUMN "class_id";
  END IF;

  ALTER TABLE "tenant"."tuition_plans" ALTER COLUMN "level_id" SET NOT NULL;
  ALTER TABLE "tenant"."tuition_plans" ALTER COLUMN "school_year_id" SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tuition_plans_level_id_levels_id_fk'
      AND conrelid = '"tenant"."tuition_plans"'::regclass
  ) THEN
    ALTER TABLE "tenant"."tuition_plans"
      ADD CONSTRAINT "tuition_plans_level_id_levels_id_fk"
      FOREIGN KEY ("level_id") REFERENCES "tenant"."levels"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tuition_plans_school_year_id_school_years_id_fk'
      AND conrelid = '"tenant"."tuition_plans"'::regclass
  ) THEN
    ALTER TABLE "tenant"."tuition_plans"
      ADD CONSTRAINT "tuition_plans_school_year_id_school_years_id_fk"
      FOREIGN KEY ("school_year_id") REFERENCES "tenant"."school_years"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tuition_plans_level_year_unique'
      AND conrelid = '"tenant"."tuition_plans"'::regclass
  ) THEN
    ALTER TABLE "tenant"."tuition_plans"
      ADD CONSTRAINT "tuition_plans_level_year_unique" UNIQUE ("level_id", "school_year_id");
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tuition_plans_school_year"
  ON "tenant"."tuition_plans" ("school_year_id", "level_id");
