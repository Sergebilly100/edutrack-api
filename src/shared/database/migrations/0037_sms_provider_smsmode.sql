-- Migrate sms_provider from orange_api → smsmode and refresh the CHECK constraint.
-- Reason: Orange CI delivery receipts proved unreliable in production. Switching to smsmode.

ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_sms_provider_check;

UPDATE public.app_settings
   SET sms_provider = 'smsmode'
 WHERE sms_provider = 'orange_api';

ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_sms_provider_check
  CHECK (sms_provider IN ('mock', 'infobip', 'africas_talking', 'twilio', 'smsmode', 'custom'));
