-- Conserve l'historique tout en ne gardant qu'un item ouvert par type/référence.
-- Cette remise en conformité couvre les schémas qui auraient reçu des doublons
-- avant l'application de l'index partiel.
WITH ranked_open_items AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY type, COALESCE(reference_id::text, 'global')
      ORDER BY generated_at DESC, id DESC
    ) AS row_number
  FROM "tenant"."dashboard_action_items"
  WHERE resolved_at IS NULL
)
UPDATE "tenant"."dashboard_action_items" AS action_item
SET resolved_at = NOW()
FROM ranked_open_items
WHERE action_item.id = ranked_open_items.id
  AND ranked_open_items.row_number > 1;--> statement-breakpoint

DROP INDEX IF EXISTS "tenant"."dashboard_action_items_type_ref_unique";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_action_items_type_ref_unique"
  ON "tenant"."dashboard_action_items" ("type", COALESCE("reference_id"::text, 'global'))
  WHERE "resolved_at" IS NULL;
