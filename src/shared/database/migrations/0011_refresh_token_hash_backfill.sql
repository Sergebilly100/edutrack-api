CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  target_schema text;
BEGIN
  FOR target_schema IN
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = 'refresh_tokens'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format(
      'UPDATE %I.refresh_tokens
       SET token = encode(digest(token, ''sha256''), ''hex'')
       WHERE token IS NOT NULL
         AND token !~ ''^[0-9a-f]{64}$''',
      target_schema
    );
  END LOOP;
END $$;
