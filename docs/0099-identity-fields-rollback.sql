-- Retour arrière de 0099_identity_fields.sql — À EXÉCUTER MANUELLEMENT, schéma par schéma
-- (remplacer "tenant" par le nom du schéma de l'école). Détruit les données saisies.
-- Ne jamais placer ce fichier dans src/shared/database/migrations (il serait rejoué).
-- La vue students_with_class n'est pas touchée par 0099 : rien à restaurer côté vue.
ALTER TABLE "tenant"."enrollments" DROP COLUMN IF EXISTS "is_repeating";
ALTER TABLE "tenant"."teachers"
  DROP COLUMN IF EXISTS "birth_place", DROP COLUMN IF EXISTS "nationality",
  DROP COLUMN IF EXISTS "sex", DROP COLUMN IF EXISTS "birth_date";
ALTER TABLE "tenant"."students"
  DROP COLUMN IF EXISTS "birth_place", DROP COLUMN IF EXISTS "nationality", DROP COLUMN IF EXISTS "sex";
