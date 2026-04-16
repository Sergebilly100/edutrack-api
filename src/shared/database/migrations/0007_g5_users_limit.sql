ALTER TABLE "public"."tenants"
ADD COLUMN IF NOT EXISTS "max_users" integer;
--> statement-breakpoint
UPDATE "public"."tenants"
SET "max_users" = CASE
  WHEN "plan" = 'essential' THEN 5
  WHEN "plan" = 'pro' THEN 20
  WHEN "plan" = 'establishment' THEN 50
  ELSE 10
END
WHERE "max_users" IS NULL OR "max_users" <= 0;
--> statement-breakpoint
ALTER TABLE "public"."tenants"
ALTER COLUMN "max_users" SET DEFAULT 10;
--> statement-breakpoint
ALTER TABLE "public"."tenants"
ALTER COLUMN "max_users" SET NOT NULL;
