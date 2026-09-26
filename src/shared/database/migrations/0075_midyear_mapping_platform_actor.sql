-- Generated with Drizzle Kit --custom. Platform mapping authors may belong to another tenant.
ALTER TABLE IF EXISTS "tenant"."import_mapping_profiles"
  DROP CONSTRAINT IF EXISTS "import_mapping_profiles_created_by_user_id_fkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "tenant"."import_mapping_profiles"
  DROP CONSTRAINT IF EXISTS "import_mapping_profiles_created_by_user_id_users_id_fk";
