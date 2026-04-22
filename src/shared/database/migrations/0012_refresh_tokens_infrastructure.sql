CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
      'CREATE TABLE IF NOT EXISTS %I.refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES %I.users(id) ON DELETE CASCADE,
        token text NOT NULL UNIQUE,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz,
        expires_at timestamptz,
        user_agent text,
        ip_address text
      )',
      target_schema,
      target_schema
    );

    EXECUTE format(
      'ALTER TABLE %I.refresh_tokens
       ADD COLUMN IF NOT EXISTS user_agent text,
       ADD COLUMN IF NOT EXISTS ip_address text,
       ADD COLUMN IF NOT EXISTS last_used_at timestamptz',
      target_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
       ON %I.refresh_tokens (user_id, is_active)',
      target_schema
    );
  END LOOP;
END $$;
