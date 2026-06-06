-- Migration: Add schedules.start_date (date de début d'application d'un créneau)
--
-- Contexte : la colonne start_date est déclarée dans le schéma Drizzle
-- (tenant.schema.ts) et dans le snapshot 0017, mais la migration SQL 0017
-- n'ajoutait que end_date. Les schémas créés uniquement via les migrations
-- (tenants de test, nouveaux tenants) se retrouvaient donc SANS start_date,
-- alors que les schémas historiques l'avaient (ajout hors migration).
--
-- Cette désynchronisation faisait planter (500) toute requête filtrant sur
-- s.start_date. On réaligne le SQL avec le schéma. Idempotent.

ALTER TABLE "tenant"."schedules"
ADD COLUMN IF NOT EXISTS "start_date" date;
