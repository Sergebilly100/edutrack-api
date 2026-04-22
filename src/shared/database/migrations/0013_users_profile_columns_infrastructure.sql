DO $$
DECLARE
  target_schema text;
BEGIN
  FOR target_schema IN
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = 'users'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.users
       ADD COLUMN IF NOT EXISTS profile_photo_url text,
       ADD COLUMN IF NOT EXISTS keycloak_subject varchar(255)',
      target_schema
    );
  END LOOP;
END $$;
