-- Ajoute la valeur d'enum notification_type 'subscription_revenue_payout'.
-- Utilisée pour notifier le directeur quand l'admin EduTrack enregistre un versement
-- "revenus abonnements" (in-app + email, jamais SMS).
DO $$
BEGIN
  ALTER TYPE "tenant"."notification_type" ADD VALUE IF NOT EXISTS 'subscription_revenue_payout';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
