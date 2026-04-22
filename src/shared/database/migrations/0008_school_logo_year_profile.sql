ALTER TABLE "public"."tenants"
ADD COLUMN IF NOT EXISTS "logo_url" text,
ADD COLUMN IF NOT EXISTS "active_school_year" varchar(20);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url text';
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;
