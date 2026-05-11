-- Migration: Add subscription_reversals table
-- Track monthly reversals from EduTrack to schools and notification status

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_catalog.pg_namespace
    WHERE nspname LIKE 'school_%'
  LOOP
    EXECUTE format($fmt$
      CREATE TABLE IF NOT EXISTS %I.subscription_reversals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id TEXT NOT NULL,
        month TEXT NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
        amount_collected NUMERIC(10, 2) NOT NULL DEFAULT 0,
        commission_rate NUMERIC(5, 2) NOT NULL DEFAULT 10.00,
        school_gain NUMERIC(10, 2) NOT NULL DEFAULT 0,
        reversed_at TIMESTAMPTZ,
        notification_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, month)
      );

      CREATE INDEX IF NOT EXISTS idx_subscription_reversals_tenant
        ON %I.subscription_reversals(tenant_id);

      CREATE INDEX IF NOT EXISTS idx_subscription_reversals_month
        ON %I.subscription_reversals(month);

      CREATE INDEX IF NOT EXISTS idx_subscription_reversals_reversed_at
        ON %I.subscription_reversals(reversed_at);
    $fmt$, schema_name, schema_name, schema_name, schema_name);
  END LOOP;
END$$;
