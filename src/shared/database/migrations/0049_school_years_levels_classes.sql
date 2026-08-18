-- Fondation V2 des années scolaires, niveaux et classes par schéma tenant.
DO $$
BEGIN
  CREATE TYPE "tenant"."school_year_status" AS ENUM ('draft', 'active', 'closed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."school_years" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "label" varchar(25) NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "status" "tenant"."school_year_status" DEFAULT 'draft' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "school_years_label_unique" UNIQUE("label"),
  CONSTRAINT "school_years_valid_dates" CHECK ("start_date" < "end_date")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_school_years_status"
  ON "tenant"."school_years" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "school_years_one_active_idx"
  ON "tenant"."school_years" USING btree ("status")
  WHERE "status" = 'active';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."levels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(100) NOT NULL,
  "order_index" integer NOT NULL,
  "is_exam_class" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "levels_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_levels_order"
  ON "tenant"."levels" USING btree ("order_index", "name");
--> statement-breakpoint
ALTER TABLE "tenant"."classes"
  ADD COLUMN IF NOT EXISTS "level_id" uuid;
--> statement-breakpoint
ALTER TABLE "tenant"."classes"
  ADD COLUMN IF NOT EXISTS "school_year_id" uuid;
--> statement-breakpoint
ALTER TABLE "tenant"."classes"
  ADD COLUMN IF NOT EXISTS "homeroom_teacher_id" uuid;
--> statement-breakpoint
ALTER TABLE "tenant"."classes"
  ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant"."classes"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'classes_level_id_levels_id_fk'
      AND conrelid = '"tenant"."classes"'::regclass
  ) THEN
    ALTER TABLE "tenant"."classes"
      ADD CONSTRAINT "classes_level_id_levels_id_fk"
      FOREIGN KEY ("level_id") REFERENCES "tenant"."levels"("id");
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'classes_school_year_id_school_years_id_fk'
      AND conrelid = '"tenant"."classes"'::regclass
  ) THEN
    ALTER TABLE "tenant"."classes"
      ADD CONSTRAINT "classes_school_year_id_school_years_id_fk"
      FOREIGN KEY ("school_year_id") REFERENCES "tenant"."school_years"("id");
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'classes_homeroom_teacher_id_teachers_id_fk'
      AND conrelid = '"tenant"."classes"'::regclass
  ) THEN
    ALTER TABLE "tenant"."classes"
      ADD CONSTRAINT "classes_homeroom_teacher_id_teachers_id_fk"
      FOREIGN KEY ("homeroom_teacher_id") REFERENCES "tenant"."teachers"("id")
      ON DELETE SET NULL;
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_classes_school_year"
  ON "tenant"."classes" USING btree ("school_year_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_classes_level"
  ON "tenant"."classes" USING btree ("level_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_classes_homeroom_teacher"
  ON "tenant"."classes" USING btree ("homeroom_teacher_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "classes_active_year_name_unique"
  ON "tenant"."classes" USING btree ("school_year_id", "name")
  WHERE "is_active" = true AND "school_year_id" IS NOT NULL;
