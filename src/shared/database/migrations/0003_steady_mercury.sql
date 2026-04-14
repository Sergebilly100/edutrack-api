DO $$ BEGIN
 CREATE TYPE "tenant"."import_type" AS ENUM('students', 'teachers', 'schedule');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."import_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_type" "tenant"."import_type" NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_import_history_type" ON "tenant"."import_history" USING btree ("import_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_import_history_imported_at" ON "tenant"."import_history" USING btree ("imported_at");
