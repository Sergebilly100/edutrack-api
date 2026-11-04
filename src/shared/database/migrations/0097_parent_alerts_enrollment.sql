ALTER TABLE public.school_sms_features
  ADD COLUMN IF NOT EXISTS mandatory_at_enrollment boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS imposed_duration_months integer,
  ADD COLUMN IF NOT EXISTS show_on_school_receipt boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE public.school_sms_features
  DROP CONSTRAINT IF EXISTS school_sms_features_imposed_duration_check;
--> statement-breakpoint
ALTER TABLE public.school_sms_features
  ADD CONSTRAINT school_sms_features_imposed_duration_check
  CHECK (
    (mandatory_at_enrollment = false AND imposed_duration_months IS NULL)
    OR (mandatory_at_enrollment = true AND imposed_duration_months IN (1, 3, 6, 12))
  );
--> statement-breakpoint
ALTER TABLE "tenant".parent_subscriptions
  ADD COLUMN IF NOT EXISTS student_id uuid,
  ADD COLUMN IF NOT EXISTS platform_share_pct numeric(5, 2),
  ADD COLUMN IF NOT EXISTS platform_share_amount_fcfa integer,
  ADD COLUMN IF NOT EXISTS renewed_from_subscription_id uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'parent_subscriptions_student_id_students_id_fk'
      AND conrelid = '"tenant".parent_subscriptions'::regclass
  ) THEN
    ALTER TABLE "tenant".parent_subscriptions
      ADD CONSTRAINT parent_subscriptions_student_id_students_id_fk
      FOREIGN KEY (student_id) REFERENCES "tenant".students(id) ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "tenant".parent_subscriptions
  DROP CONSTRAINT IF EXISTS parent_subscriptions_platform_share_check;
--> statement-breakpoint
ALTER TABLE "tenant".parent_subscriptions
  ADD CONSTRAINT parent_subscriptions_platform_share_check
  CHECK (
    platform_share_pct >= 0 AND platform_share_pct <= 100
    AND platform_share_amount_fcfa >= 0
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_parent_subs_student
  ON "tenant".parent_subscriptions (student_id);
--> statement-breakpoint
ALTER TABLE "tenant".subscription_payments
  ADD COLUMN IF NOT EXISTS platform_share_amount_fcfa integer,
  ADD COLUMN IF NOT EXISTS payment_purpose varchar(30) NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE "tenant".subscription_payments
  DROP CONSTRAINT IF EXISTS subscription_payments_method_check;
--> statement-breakpoint
ALTER TABLE "tenant".subscription_payments
  ADD CONSTRAINT subscription_payments_method_check
  CHECK (payment_method IN ('cash', 'momo_mtn', 'momo_orange', 'mobile_money', 'bank_transfer'));
--> statement-breakpoint
ALTER TABLE "tenant".subscription_payments
  DROP CONSTRAINT IF EXISTS subscription_payments_platform_share_non_negative_check;
--> statement-breakpoint
ALTER TABLE "tenant".subscription_payments
  ADD CONSTRAINT subscription_payments_platform_share_non_negative_check
  CHECK (platform_share_amount_fcfa >= 0);
--> statement-breakpoint
ALTER TABLE "tenant".subscription_payments
  DROP CONSTRAINT IF EXISTS subscription_payments_purpose_check;
--> statement-breakpoint
ALTER TABLE "tenant".subscription_payments
  ADD CONSTRAINT subscription_payments_purpose_check
  CHECK (payment_purpose IN ('manual', 'enrollment', 'renewal'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant".enrollment_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  payment_id uuid UNIQUE,
  subscription_payment_id uuid UNIQUE,
  student_id uuid NOT NULL,
  school_year_id uuid NOT NULL,
  total_amount numeric(12, 2) NOT NULL,
  tuition_amount numeric(12, 2) NOT NULL,
  parent_alerts_amount numeric(12, 2) NOT NULL DEFAULT 0,
  show_parent_alerts_on_receipt boolean NOT NULL DEFAULT false,
  allocated_by_user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT enrollment_payment_allocations_payment_id_payments_id_fk
    FOREIGN KEY (payment_id) REFERENCES "tenant".payments(id) ON DELETE RESTRICT,
  CONSTRAINT enrollment_payment_allocations_subscription_payment_id_subscription_payments_id_fk
    FOREIGN KEY (subscription_payment_id) REFERENCES "tenant".subscription_payments(id) ON DELETE RESTRICT,
  CONSTRAINT enrollment_payment_allocations_student_id_students_id_fk
    FOREIGN KEY (student_id) REFERENCES "tenant".students(id) ON DELETE RESTRICT,
  CONSTRAINT enrollment_payment_allocations_school_year_id_school_years_id_fk
    FOREIGN KEY (school_year_id) REFERENCES "tenant".school_years(id) ON DELETE RESTRICT,
  CONSTRAINT enrollment_payment_allocations_allocated_by_user_id_users_id_fk
    FOREIGN KEY (allocated_by_user_id) REFERENCES "tenant".users(id),
  CONSTRAINT enrollment_payment_allocations_amounts_check
    CHECK (
      (payment_id IS NOT NULL OR subscription_payment_id IS NOT NULL)
      AND total_amount > 0
      AND tuition_amount >= 0
      AND parent_alerts_amount >= 0
      AND total_amount = tuition_amount + parent_alerts_amount
    )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_enrollment_payment_allocations_student_year
  ON "tenant".enrollment_payment_allocations (student_id, school_year_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant".parent_subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  subscription_id uuid NOT NULL,
  action varchar(30) NOT NULL,
  actor_user_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT parent_subscription_events_subscription_id_parent_subscriptions_id_fk
    FOREIGN KEY (subscription_id) REFERENCES "tenant".parent_subscriptions(id) ON DELETE RESTRICT,
  CONSTRAINT parent_subscription_events_actor_user_id_users_id_fk
    FOREIGN KEY (actor_user_id) REFERENCES "tenant".users(id),
  CONSTRAINT parent_subscription_events_action_check
    CHECK (action IN ('created', 'activated', 'renewed', 'expired', 'cancelled', 'reversal_recorded'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_parent_subscription_events_subscription
  ON "tenant".parent_subscription_events (subscription_id, created_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant".reject_enrollment_allocation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'enrollment payment allocations are immutable';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS enrollment_payment_allocations_immutable
  ON "tenant".enrollment_payment_allocations;
--> statement-breakpoint
CREATE TRIGGER enrollment_payment_allocations_immutable
  BEFORE UPDATE OR DELETE ON "tenant".enrollment_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION "tenant".reject_enrollment_allocation_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant".reject_parent_subscription_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'parent subscription events are immutable';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS parent_subscription_events_immutable
  ON "tenant".parent_subscription_events;
--> statement-breakpoint
CREATE TRIGGER parent_subscription_events_immutable
  BEFORE UPDATE OR DELETE ON "tenant".parent_subscription_events
  FOR EACH ROW EXECUTE FUNCTION "tenant".reject_parent_subscription_event_mutation();
