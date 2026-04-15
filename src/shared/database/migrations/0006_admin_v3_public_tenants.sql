DO $$ BEGIN
 CREATE TYPE "public"."teaching_type" AS ENUM('primaire', 'secondaire', 'superieur', 'mixte');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "public"."tenants"
ADD COLUMN IF NOT EXISTS "city" varchar(120);
--> statement-breakpoint
ALTER TABLE "public"."tenants"
ADD COLUMN IF NOT EXISTS "teaching_type" "public"."teaching_type";
--> statement-breakpoint
ALTER TABLE "public"."tenants"
ADD COLUMN IF NOT EXISTS "max_admin_positions" integer DEFAULT 5 NOT NULL;
