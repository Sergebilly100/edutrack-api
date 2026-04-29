ALTER TABLE "tenant"."parents"
ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT true NOT NULL;
