ALTER TABLE "public"."tenants"
  ADD COLUMN IF NOT EXISTS "student_label" varchar(120) DEFAULT 'Élève',
  ADD COLUMN IF NOT EXISTS "director_title" varchar(120) DEFAULT 'Directeur',
  ADD COLUMN IF NOT EXISTS "max_sms_per_month" integer DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS "can_edit_sms_template" boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS "can_export_data" boolean DEFAULT true;

CREATE TABLE IF NOT EXISTS "public"."sms_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid REFERENCES "public"."tenants"("id") ON DELETE CASCADE,
  "type" varchar(50) NOT NULL,
  "message_template" text NOT NULL,
  "variables" text[] NOT NULL DEFAULT '{}',
  "created_by" uuid,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE("tenant_id", "type")
);

CREATE TABLE IF NOT EXISTS "public"."app_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "maintenance_mode" boolean NOT NULL DEFAULT false,
  "maintenance_message" text NOT NULL DEFAULT 'Mise à jour en cours',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

INSERT INTO "public"."app_settings" (maintenance_mode, maintenance_message)
SELECT false, 'Mise à jour en cours'
WHERE NOT EXISTS (SELECT 1 FROM "public"."app_settings");
