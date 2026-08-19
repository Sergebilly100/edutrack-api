DO $$
BEGIN
  CREATE TYPE "tenant"."finance_payment_method" AS ENUM ('mobile_money', 'cash', 'bank_transfer');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "tenant"."payment_source" AS ENUM ('in_app_button', 'cashier_manual', 'bulk_import', 'migration_import');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "tenant"."finance_payment_status" AS ENUM ('confirmed', 'waived_by_school', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "tenant"."mobile_money_provider" AS ENUM ('orange_money', 'mtn_momo', 'moov_money', 'wave');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "tenant"."subscription_period" AS ENUM ('monthly', 'quarterly', 'semester', 'annual');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
ALTER TABLE "tenant"."notifications_log"
  DROP CONSTRAINT IF EXISTS "notifications_log_channel_check";
--> statement-breakpoint
ALTER TABLE "tenant"."notifications_log"
  ADD CONSTRAINT "notifications_log_channel_check"
  CHECK ("channel" IN ('sms', 'email', 'in_app'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."tuition_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "class_id" uuid NOT NULL REFERENCES "tenant"."classes"("id") ON DELETE CASCADE,
  "total_amount" numeric(12, 2) NOT NULL,
  "currency" varchar(10) DEFAULT 'FCFA' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "tuition_plans_class_unique" UNIQUE("class_id"),
  CONSTRAINT "tuition_plans_amount_non_negative" CHECK ("total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."tuition_schedule_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tuition_plan_id" uuid NOT NULL REFERENCES "tenant"."tuition_plans"("id") ON DELETE CASCADE,
  "due_date" date NOT NULL,
  "cumulative_amount_expected" numeric(12, 2) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "tuition_schedule_steps_plan_date_unique" UNIQUE("tuition_plan_id", "due_date"),
  CONSTRAINT "tuition_schedule_steps_amount_non_negative" CHECK ("cumulative_amount_expected" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tuition_schedule_steps_due_date"
  ON "tenant"."tuition_schedule_steps" ("tuition_plan_id", "due_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."student_tuition_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "school_year_id" uuid NOT NULL REFERENCES "tenant"."school_years"("id") ON DELETE CASCADE,
  "override_total_amount" numeric(12, 2),
  "discount_amount" numeric(12, 2),
  "reason" text NOT NULL,
  "granted_by_user_id" uuid NOT NULL REFERENCES "tenant"."users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "student_tuition_overrides_student_year_unique" UNIQUE("student_id", "school_year_id"),
  CONSTRAINT "student_tuition_overrides_one_value" CHECK (
    ("override_total_amount" IS NOT NULL AND "discount_amount" IS NULL)
    OR ("override_total_amount" IS NULL AND "discount_amount" IS NOT NULL)
  ),
  CONSTRAINT "student_tuition_overrides_override_non_negative" CHECK ("override_total_amount" IS NULL OR "override_total_amount" >= 0),
  CONSTRAINT "student_tuition_overrides_discount_non_negative" CHECK ("discount_amount" IS NULL OR "discount_amount" >= 0),
  CONSTRAINT "student_tuition_overrides_reason_required" CHECK (length(btrim("reason")) > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_student_tuition_overrides_student_year"
  ON "tenant"."student_tuition_overrides" ("student_id", "school_year_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."payment_provider_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" "tenant"."mobile_money_provider" NOT NULL,
  "merchant_number" varchar(100) NOT NULL,
  "api_credentials" jsonb NOT NULL,
  "is_active" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_provider_settings_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_provider_settings_active"
  ON "tenant"."payment_provider_settings" ("is_active") WHERE "is_active" = true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id"),
  "school_year_id" uuid NOT NULL REFERENCES "tenant"."school_years"("id"),
  "amount" numeric(12, 2) NOT NULL,
  "method" "tenant"."finance_payment_method" NOT NULL,
  "source" "tenant"."payment_source" NOT NULL,
  "status" "tenant"."finance_payment_status" DEFAULT 'confirmed' NOT NULL,
  "confirmed_by_user_id" uuid REFERENCES "tenant"."users"("id"),
  "provider_reference" varchar(255),
  "school_receipt_reference" varchar(255),
  "receipt_number" varchar(100) NOT NULL,
  "cancelled_at" timestamptz,
  "cancelled_by_user_id" uuid REFERENCES "tenant"."users"("id"),
  "cancellation_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payments_receipt_number_unique" UNIQUE("receipt_number"),
  CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "payments_cancellation_consistent" CHECK (
    ("status" <> 'cancelled' AND "cancelled_at" IS NULL AND "cancelled_by_user_id" IS NULL AND "cancellation_reason" IS NULL)
    OR ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND length(btrim("cancellation_reason")) > 0)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payments_student_year_created"
  ON "tenant"."payments" ("student_id", "school_year_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payments_confirmed_student_year"
  ON "tenant"."payments" ("student_id", "school_year_id") WHERE "status" = 'confirmed';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."subscription_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "amount" numeric(12, 2) NOT NULL,
  "period" "tenant"."subscription_period" NOT NULL,
  "label" varchar(255) NOT NULL,
  "is_mandatory_at_enrollment" boolean DEFAULT false NOT NULL,
  "imposed_duration" "tenant"."subscription_period",
  "show_on_receipt_as_separate_line" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "subscription_plans_amount_non_negative" CHECK ("amount" >= 0),
  CONSTRAINT "subscription_plans_label_required" CHECK (length(btrim("label")) > 0),
  CONSTRAINT "subscription_plans_imposed_duration_consistent" CHECK (
    ("is_mandatory_at_enrollment" = true AND "imposed_duration" IS NOT NULL)
    OR ("is_mandatory_at_enrollment" = false AND "imposed_duration" IS NULL)
  )
);
