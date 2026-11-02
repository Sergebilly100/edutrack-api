ALTER TABLE "tenant"."tuition_plans"
  ADD COLUMN IF NOT EXISTS "registration_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tuition_plans_registration_amount_non_negative'
      AND conrelid = '"tenant"."tuition_plans"'::regclass
  ) THEN
    ALTER TABLE "tenant"."tuition_plans"
      ADD CONSTRAINT "tuition_plans_registration_amount_non_negative"
      CHECK ("registration_amount" >= 0);
  END IF;
END
$$;--> statement-breakpoint
