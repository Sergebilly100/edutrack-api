-- Ajout de updated_at sur salary_records pour tracer la date réelle du dernier recalcul.
-- created_at reste figé à la première insertion (invariant).
-- updated_at est mis à jour à chaque upsert (recalcul ou paiement).
ALTER TABLE "tenant"."salary_records"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

-- Initialiser updated_at = created_at pour les lignes existantes
UPDATE "tenant"."salary_records"
  SET updated_at = created_at
  WHERE updated_at IS NULL OR updated_at = created_at;
