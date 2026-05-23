-- Ajout du suivi des credentials sur la table users (tenant schema)
-- - must_change_password : force la modification du mot de passe à la prochaine connexion
-- - credentials_sent_at : horodatage du dernier envoi des identifiants par email

ALTER TABLE "tenant"."users"
ADD COLUMN IF NOT EXISTS "must_change_password" boolean NOT NULL DEFAULT false;

ALTER TABLE "tenant"."users"
ADD COLUMN IF NOT EXISTS "credentials_sent_at" timestamptz;
