ALTER TABLE "public"."tenants" ADD COLUMN IF NOT EXISTS "evaluation_grace_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "public"."tenants" ADD COLUMN IF NOT EXISTS "evaluation_late_days" integer DEFAULT 14 NOT NULL;
