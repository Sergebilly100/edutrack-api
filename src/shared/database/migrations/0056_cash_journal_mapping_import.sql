ALTER TABLE "tenant"."payments"
  ADD COLUMN IF NOT EXISTS "payment_date" date;
--> statement-breakpoint
UPDATE "tenant"."payments"
SET "payment_date" = "created_at"::date
WHERE "payment_date" IS NULL;
--> statement-breakpoint
ALTER TABLE "tenant"."payments"
  ALTER COLUMN "payment_date" SET DEFAULT CURRENT_DATE;
--> statement-breakpoint
ALTER TABLE "tenant"."payments"
  ALTER COLUMN "payment_date" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payments_journal_filters"
  ON "tenant"."payments" ("payment_date" DESC, "method", "student_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."import_mapping_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "import_type" varchar(80) NOT NULL,
  "label" varchar(255),
  "created_by_user_id" uuid NOT NULL REFERENCES "tenant"."users"("id"),
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "import_mapping_profiles_type_required"
    CHECK (length(btrim("import_type")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_mapping_profiles_one_active_type"
  ON "tenant"."import_mapping_profiles" ("import_type")
  WHERE "is_active" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_import_mapping_profiles_type_updated"
  ON "tenant"."import_mapping_profiles" ("import_type", "updated_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."import_mapping_fields" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "tenant"."import_mapping_profiles"("id") ON DELETE CASCADE,
  "source_column_label" varchar(255) NOT NULL,
  "target_field" varchar(100) NOT NULL,
  "is_required" boolean DEFAULT false NOT NULL,
  CONSTRAINT "import_mapping_fields_source_required"
    CHECK (length(btrim("source_column_label")) > 0),
  CONSTRAINT "import_mapping_fields_target_required"
    CHECK (length(btrim("target_field")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_mapping_fields_profile_source_unique"
  ON "tenant"."import_mapping_fields" ("profile_id", lower("source_column_label"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_mapping_fields_profile_target_unique"
  ON "tenant"."import_mapping_fields" ("profile_id", "target_field");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."import_mapping_value_translations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mapping_field_id" uuid NOT NULL REFERENCES "tenant"."import_mapping_fields"("id") ON DELETE CASCADE,
  "source_value" varchar(255) NOT NULL,
  "target_value" varchar(255) NOT NULL,
  CONSTRAINT "import_mapping_value_source_required"
    CHECK (length(btrim("source_value")) > 0),
  CONSTRAINT "import_mapping_value_target_required"
    CHECK (length(btrim("target_value")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_mapping_values_field_source_unique"
  ON "tenant"."import_mapping_value_translations" ("mapping_field_id", lower("source_value"));
