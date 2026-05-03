ALTER TYPE "tenant"."salary_status" ADD VALUE IF NOT EXISTS 'nothing_to_pay';--> statement-breakpoint
ALTER TABLE public.school_sms_features
ADD COLUMN IF NOT EXISTS monetize_parent_alerts boolean NOT NULL DEFAULT false;
