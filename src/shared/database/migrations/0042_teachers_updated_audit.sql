-- Ajout d'un audit minimal sur la table teachers :
--   updated_at : horodatage de la dernière modification
--   updated_by : utilisateur ayant effectué la dernière modification
-- Permet de répondre à la question "qui a modifié quoi et quand"
-- sans introduire de table d'historique complète.

ALTER TABLE "tenant"."teachers"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT NOW();

ALTER TABLE "tenant"."teachers"
  ADD COLUMN IF NOT EXISTS "updated_by" uuid REFERENCES "tenant"."users"("id");

CREATE INDEX IF NOT EXISTS "idx_teachers_updated_at"
  ON "tenant"."teachers" USING btree ("updated_at" DESC);
