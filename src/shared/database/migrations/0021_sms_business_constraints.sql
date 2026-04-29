ALTER TABLE public.school_sms_features
  DROP CONSTRAINT IF EXISTS school_sms_features_commission_pct_range_check;
ALTER TABLE public.school_sms_features
  ADD CONSTRAINT school_sms_features_commission_pct_range_check
  CHECK (commission_pct >= 0 AND commission_pct <= 100);
--> statement-breakpoint

ALTER TABLE public.school_sms_features
  DROP CONSTRAINT IF EXISTS school_sms_features_sms_cap_non_negative_check;
ALTER TABLE public.school_sms_features
  ADD CONSTRAINT school_sms_features_sms_cap_non_negative_check
  CHECK (sms_cap_per_student >= 0);
--> statement-breakpoint

ALTER TABLE "tenant"."parent_subscriptions"
  DROP CONSTRAINT IF EXISTS parent_subscriptions_unit_price_non_negative_check;
ALTER TABLE "tenant"."parent_subscriptions"
  ADD CONSTRAINT parent_subscriptions_unit_price_non_negative_check
  CHECK (unit_price_fcfa >= 0);
--> statement-breakpoint

ALTER TABLE "tenant"."parent_subscriptions"
  DROP CONSTRAINT IF EXISTS parent_subscriptions_total_amount_non_negative_check;
ALTER TABLE "tenant"."parent_subscriptions"
  ADD CONSTRAINT parent_subscriptions_total_amount_non_negative_check
  CHECK (total_amount_fcfa >= 0);
--> statement-breakpoint

ALTER TABLE "tenant"."subscription_payments"
  DROP CONSTRAINT IF EXISTS subscription_payments_amount_non_negative_check;
ALTER TABLE "tenant"."subscription_payments"
  ADD CONSTRAINT subscription_payments_amount_non_negative_check
  CHECK (amount_fcfa >= 0);
--> statement-breakpoint

ALTER TABLE public.edutrack_commission_records
  DROP CONSTRAINT IF EXISTS edutrack_commission_records_total_non_negative_check;
ALTER TABLE public.edutrack_commission_records
  ADD CONSTRAINT edutrack_commission_records_total_non_negative_check
  CHECK (total_subscriptions_fcfa >= 0);
--> statement-breakpoint

ALTER TABLE public.edutrack_commission_records
  DROP CONSTRAINT IF EXISTS edutrack_commission_records_due_non_negative_check;
ALTER TABLE public.edutrack_commission_records
  ADD CONSTRAINT edutrack_commission_records_due_non_negative_check
  CHECK (commission_due_fcfa >= 0);
--> statement-breakpoint

ALTER TABLE public.edutrack_commission_records
  DROP CONSTRAINT IF EXISTS edutrack_commission_records_paid_non_negative_check;
ALTER TABLE public.edutrack_commission_records
  ADD CONSTRAINT edutrack_commission_records_paid_non_negative_check
  CHECK (commission_paid_fcfa >= 0);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "tenant".prevent_parent_student_active_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  incoming_starts date;
  incoming_ends date;
  incoming_status varchar(20);
  conflict_exists boolean;
BEGIN
  SELECT ps.starts_at, ps.ends_at, ps.status
    INTO incoming_starts, incoming_ends, incoming_status
  FROM "tenant"."parent_subscriptions" ps
  WHERE ps.id = NEW.subscription_id;

  IF incoming_status IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "tenant"."parent_student_links" psl
    INNER JOIN "tenant"."parent_subscriptions" ps ON ps.id = psl.subscription_id
    WHERE psl.parent_id = NEW.parent_id
      AND psl.student_id = NEW.student_id
      AND psl.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND ps.status = 'active'
      AND daterange(ps.starts_at, ps.ends_at, '[]')
          && daterange(incoming_starts, incoming_ends, '[]')
  ) INTO conflict_exists;

  IF conflict_exists THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Active subscription overlap for parent/student is not allowed',
      ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_parent_student_links_no_active_overlap ON "tenant"."parent_student_links";
--> statement-breakpoint
CREATE TRIGGER trg_parent_student_links_no_active_overlap
BEFORE INSERT OR UPDATE ON "tenant"."parent_student_links"
FOR EACH ROW
EXECUTE FUNCTION "tenant".prevent_parent_student_active_overlap();
