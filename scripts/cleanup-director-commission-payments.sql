-- Nettoyage des reversements enregistrés via subscriptions.record_commission_payment
-- Ces événements ont été créés par un super_admin sur la page directeur (endpoint
-- désormais supprimé). Ils créaient une divergence entre audit_financial_events et
-- la vue admin qui n'interrogeait que admin.record_commission_received.
--
-- AVANT D'EXÉCUTER :
--   1. Vérifier le contenu : remplacez <TENANT_ID> par l'UUID réel de l'école
--   2. Lancer en READ-ONLY d'abord (SELECT) pour confirmer les lignes à supprimer
--   3. Ajuster commission_paid_fcfa dans edutrack_commission_records si nécessaire

-- Étape 1 : Voir les événements à supprimer
SELECT
  id,
  actor_role,
  action,
  created_at,
  payload_after->>'period_month' AS period_month,
  payload_after->>'amount_fcfa' AS amount_fcfa,
  payload_after->>'notes' AS notes
FROM public.audit_financial_events
WHERE action = 'subscriptions.record_commission_payment'
  -- AND tenant_id = '<TENANT_ID>'::uuid  -- décommentez pour filtrer une école
ORDER BY created_at DESC;


-- Étape 2 : Voir l'impact sur edutrack_commission_records avant suppression
SELECT
  ecr.tenant_id,
  t.name AS school_name,
  ecr.period_month,
  ecr.commission_due_fcfa,
  ecr.commission_paid_fcfa,
  GREATEST(0, ecr.commission_due_fcfa - ecr.commission_paid_fcfa) AS remaining
FROM public.edutrack_commission_records ecr
JOIN public.tenants t ON t.id = ecr.tenant_id
WHERE ecr.tenant_id IN (
  SELECT DISTINCT tenant_id
  FROM public.audit_financial_events
  WHERE action = 'subscriptions.record_commission_payment'
)
ORDER BY ecr.period_month DESC;


-- Étape 3 : Calculer le montant cumulé par (tenant, mois) à déduire de commission_paid_fcfa
-- (Ces montants ont été additionnés via UPSERT dans runCommissionPaymentWithAudit)
SELECT
  tenant_id,
  LEFT(payload_after->>'period_month', 7) AS period_month,
  SUM((payload_after->>'amount_fcfa')::int) AS total_to_remove
FROM public.audit_financial_events
WHERE action = 'subscriptions.record_commission_payment'
GROUP BY tenant_id, LEFT(payload_after->>'period_month', 7);


-- Étape 4 : SUPPRESSION + correction des records
-- Remplacez le BEGIN/ROLLBACK par BEGIN/COMMIT une fois vérifié.
BEGIN;

  -- 4a. Corriger commission_paid_fcfa dans les records
  UPDATE public.edutrack_commission_records ecr
  SET
    commission_paid_fcfa = GREATEST(0, ecr.commission_paid_fcfa - agg.total_to_remove),
    updated_at = NOW()
  FROM (
    SELECT
      tenant_id,
      (LEFT(payload_after->>'period_month', 7) || '-01')::date AS period_month,
      SUM((payload_after->>'amount_fcfa')::int) AS total_to_remove
    FROM public.audit_financial_events
    WHERE action = 'subscriptions.record_commission_payment'
    GROUP BY tenant_id, LEFT(payload_after->>'period_month', 7)
  ) agg
  WHERE ecr.tenant_id = agg.tenant_id
    AND ecr.period_month = agg.period_month;

  -- 4b. Supprimer les événements audit
  DELETE FROM public.audit_financial_events
  WHERE action = 'subscriptions.record_commission_payment';

ROLLBACK; -- Remplacer par COMMIT une fois la vérification faite
