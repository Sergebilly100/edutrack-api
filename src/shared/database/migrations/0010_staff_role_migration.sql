DO $$
DECLARE
  target_schema text;
BEGIN
  FOR target_schema IN
    SELECT n.nspname
    FROM pg_namespace n
    JOIN pg_type t
      ON t.typnamespace = n.oid
     AND t.typname = 'user_role'
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = target_schema
        AND table_name = 'users'
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TYPE %I.user_role RENAME TO user_role_legacy',
      target_schema
    );

    EXECUTE format(
      'CREATE TYPE %I.user_role AS ENUM (''director'', ''staff'', ''teacher'', ''super_admin'')',
      target_schema
    );

    EXECUTE format(
      'ALTER TABLE %I.users
       ALTER COLUMN role
       TYPE %I.user_role
       USING (
         CASE
           WHEN role::text = ''secretary'' THEN ''staff''
           ELSE role::text
         END
       )::%I.user_role',
      target_schema,
      target_schema,
      target_schema
    );

    EXECUTE format(
      'DROP TYPE %I.user_role_legacy',
      target_schema
    );
  END LOOP;
END $$;
