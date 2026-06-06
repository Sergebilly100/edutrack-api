-- Migration: Cleanup phantom permanent salary records
--
-- Contexte : computeSalaryRecords créait une fiche de salaire pour CHAQUE
-- enseignant permanent à chaque calcul, au montant du forfait mensuel, sans
-- vérifier s'il avait des heures planifiées ce mois-là. Résultat : des fiches
-- "fantômes" (hours_planned = 0, hours_done = 0) restaient en statut 'pending'
-- sur des mois où le prof n'était pas en service, gonflant le "Total à payer"
-- et les alertes de salaires non soldés (ex: septembre 2025, février 2026).
--
-- Le code est corrigé pour ne plus en créer (skip permanent si hours_planned <= 0).
-- Cette migration nettoie les fiches déjà présentes.
--
-- Note multi-tenant : le runner (tenant-init.ts / migrate-all-tenants.ts) exécute
-- ce fichier une fois par schéma en remplaçant "tenant" par le nom réel du schéma.
--
-- Garde-fous : on ne supprime QUE les fiches sans aucune activité, jamais
-- payées, jamais disputées, et sans aucun paiement enregistré. Idempotent.

DELETE FROM "tenant".salary_records sr
USING "tenant".teachers t
WHERE sr.teacher_id = t.id
  AND t.type = 'permanent'
  AND sr.hours_planned <= 0
  AND sr.hours_done <= 0
  AND sr.status::text NOT IN ('paid', 'disputed')
  AND sr.paid_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "tenant".salary_payments sp
    WHERE sp.salary_record_id = sr.id
  );
