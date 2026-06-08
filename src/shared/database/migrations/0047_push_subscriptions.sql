-- Migration: Add push_subscriptions table (Web Push)
-- Stocke les abonnements Web Push des profs/staff (users) et des parents (parents).
-- Le push complète les SMS/email ; un même utilisateur peut avoir plusieurs
-- abonnements (plusieurs appareils/navigateurs).

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
      CREATE TABLE IF NOT EXISTS %I.push_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        -- 'user' = prof/staff/directeur (table users) ; 'parent' = table parents
        subscriber_type TEXT NOT NULL CHECK (subscriber_type IN ('user', 'parent')),
        subscriber_id UUID NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        -- L'endpoint identifie de façon unique un abonnement navigateur :
        -- on évite les doublons si l'utilisateur se réabonne avec le même device.
        UNIQUE (endpoint)
      );

      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_subscriber
        ON %I.push_subscriptions(subscriber_type, subscriber_id);
    $fmt$, schema_name, schema_name);
  END LOOP;
END $$;
