-- Numéros de reçus REC-AAAAMMJJ-NNNN : un compteur par jour (fuseau de l'école), incrémenté dans la transaction du paiement.
-- Heure réelle du paiement (paid_at) : renseignée seulement quand elle est connue (encaissement à la caisse).
-- Idempotent : CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, colonne nullable sans valeur par défaut
-- (pas de réécriture de la table, pas de verrou long). Les numéros déjà émis ne changent jamais.
CREATE TABLE IF NOT EXISTS "tenant"."payment_receipt_counters" (
  "day" date PRIMARY KEY NOT NULL,
  "last_number" integer NOT NULL,
  CONSTRAINT "payment_receipt_counters_last_number_positive" CHECK ("last_number" > 0)
);--> statement-breakpoint
ALTER TABLE "tenant"."payments" ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;
