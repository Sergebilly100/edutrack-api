-- Identité : sexe, nationalité (ISO 3166-1 alpha-2), lieu de naissance (élèves, professeurs),
-- date de naissance des professeurs, et redoublant rattaché à l'inscription.
-- Toutes les colonnes sont nullables, sans valeur par défaut : "non renseigné" est un état valide.
-- Idempotent : ADD COLUMN IF NOT EXISTS (la contrainte inline n'est posée qu'avec la colonne).
ALTER TABLE "tenant"."students"
  ADD COLUMN IF NOT EXISTS "sex" varchar(1) CONSTRAINT "students_sex_check" CHECK ("sex" IN ('M', 'F')),
  ADD COLUMN IF NOT EXISTS "nationality" varchar(2) CONSTRAINT "students_nationality_check" CHECK ("nationality" ~ '^[A-Z]{2}$'),
  ADD COLUMN IF NOT EXISTS "birth_place" varchar(120);
--> statement-breakpoint
ALTER TABLE "tenant"."teachers"
  ADD COLUMN IF NOT EXISTS "birth_date" date,
  ADD COLUMN IF NOT EXISTS "sex" varchar(1) CONSTRAINT "teachers_sex_check" CHECK ("sex" IN ('M', 'F')),
  ADD COLUMN IF NOT EXISTS "nationality" varchar(2) CONSTRAINT "teachers_nationality_check" CHECK ("nationality" ~ '^[A-Z]{2}$'),
  ADD COLUMN IF NOT EXISTS "birth_place" varchar(120);
--> statement-breakpoint
ALTER TABLE "tenant"."enrollments"
  ADD COLUMN IF NOT EXISTS "is_repeating" boolean;
-- La vue students_with_class n'est volontairement PAS modifiée (0074 doit rester rejouable) :
-- les lectures d'identité joignent directement la table students.
