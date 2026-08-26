ALTER TABLE "public"."tenants"
  ADD COLUMN IF NOT EXISTS "mid_year_onboarding" boolean NOT NULL DEFAULT false;--> statement-breakpoint
