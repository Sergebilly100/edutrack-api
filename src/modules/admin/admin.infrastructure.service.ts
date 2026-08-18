import { sql } from 'drizzle-orm';

import type { TenantDb } from '../../shared/database/db.js';

export const ensureAdminPublicInfrastructure = async (publicDb: TenantDb): Promise<void> => {
  await publicDb.execute(sql.raw(`
    ALTER TABLE public.tenants
      ADD COLUMN IF NOT EXISTS student_label varchar(120) DEFAULT 'Élève',
      ADD COLUMN IF NOT EXISTS director_title varchar(120) DEFAULT 'Directeur',
      ADD COLUMN IF NOT EXISTS max_sms_per_month integer DEFAULT 2000,
      ADD COLUMN IF NOT EXISTS can_edit_sms_template boolean DEFAULT false,
      ADD COLUMN IF NOT EXISTS can_export_data boolean DEFAULT true,
      ADD COLUMN IF NOT EXISTS active_school_year varchar(20),
      ADD COLUMN IF NOT EXISTS logo_url text;
  `));

  await publicDb.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.sms_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
      type varchar(50) NOT NULL,
      message_template text NOT NULL,
      variables text[] NOT NULL DEFAULT '{}',
      created_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(tenant_id, type)
    );
  `));

  await publicDb.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.app_settings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      maintenance_mode boolean NOT NULL DEFAULT false,
      maintenance_message text NOT NULL DEFAULT 'Mise à jour en cours',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `));

  await publicDb.execute(sql.raw(`
    ALTER TABLE public.app_settings
      ADD COLUMN IF NOT EXISTS sms_provider varchar(50) NOT NULL DEFAULT 'mock',
      ADD COLUMN IF NOT EXISTS sms_api_base_url varchar(255),
      ADD COLUMN IF NOT EXISTS sms_api_key text,
      ADD COLUMN IF NOT EXISTS sms_api_key_last4 varchar(4),
      ADD COLUMN IF NOT EXISTS sms_api_key_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS sms_sender_id varchar(20) NOT NULL DEFAULT 'IvoirEdu',
      ADD COLUMN IF NOT EXISTS sms_fallback_sender_id varchar(20),
      ADD COLUMN IF NOT EXISTS sms_default_country_code varchar(8) NOT NULL DEFAULT '+225',
      ADD COLUMN IF NOT EXISTS sms_alert_quota_threshold_pct integer NOT NULL DEFAULT 80,
      ADD COLUMN IF NOT EXISTS sms_alert_failure_threshold_count integer NOT NULL DEFAULT 5,
      ADD COLUMN IF NOT EXISTS sms_alert_email varchar(255),
      ADD COLUMN IF NOT EXISTS sms_maintenance_mode boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS sms_maintenance_message text NOT NULL DEFAULT 'Service SMS en maintenance';
  `));

  await publicDb.execute(sql.raw(`
    ALTER TABLE public.app_settings
      DROP CONSTRAINT IF EXISTS app_settings_sms_provider_check;
    UPDATE public.app_settings SET sms_provider = 'smsmode' WHERE sms_provider = 'orange_api';
    ALTER TABLE public.app_settings
      ADD CONSTRAINT app_settings_sms_provider_check
      CHECK (sms_provider IN ('mock', 'infobip', 'africas_talking', 'twilio', 'smsmode', 'custom'));
  `));

  await publicDb.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.sms_admin_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      admin_id uuid,
      action varchar(80) NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `));

  await publicDb.execute(sql.raw(`
    INSERT INTO public.app_settings (maintenance_mode, maintenance_message)
    SELECT false, 'Mise à jour en cours'
    WHERE NOT EXISTS (SELECT 1 FROM public.app_settings);
  `));

  await publicDb.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.plan_catalog (
      plan tenant_plan PRIMARY KEY,
      monthly_price_fcfa integer NOT NULL DEFAULT 0,
      annual_price_fcfa integer NOT NULL DEFAULT 0,
      default_billing_cycle billing_cycle NOT NULL DEFAULT 'monthly',
      max_users integer NOT NULL DEFAULT 10,
      max_admin_positions integer NOT NULL DEFAULT 5,
      max_sms_per_month integer NOT NULL DEFAULT 2000,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `));

  await publicDb.execute(sql.raw(`
    INSERT INTO public.plan_catalog (
      plan,
      monthly_price_fcfa,
      annual_price_fcfa,
      default_billing_cycle,
      max_users,
      max_admin_positions,
      max_sms_per_month
    )
    VALUES
      ('essential', 15000, 162000, 'monthly', 5, 5, 2000),
      ('pro', 30000, 324000, 'monthly', 20, 15, 6000),
      ('establishment', 50000, 540000, 'monthly', 50, 30, 12000)
    ON CONFLICT (plan) DO NOTHING;
  `));
};
