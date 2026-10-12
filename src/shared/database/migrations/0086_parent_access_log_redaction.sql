-- Data-only, idempotent cleanup of messages persisted by the former parent-access flow.
-- Old credentials must not remain readable in notification history or be replayed.
UPDATE "tenant"."notifications_log"
SET message = '[Identifiants parent : historique masqué]'
WHERE type::text = 'parent_access_credentials'
  AND message <> '[Identifiants parent : historique masqué]';
