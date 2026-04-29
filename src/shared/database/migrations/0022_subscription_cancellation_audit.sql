ALTER TABLE "tenant"."parent_subscriptions"
  ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;

ALTER TABLE "tenant"."parent_subscriptions"
  ADD COLUMN IF NOT EXISTS "cancelled_by" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'parent_subscriptions_cancelled_by_users_id_fk'
  ) THEN
    ALTER TABLE "tenant"."parent_subscriptions"
      ADD CONSTRAINT "parent_subscriptions_cancelled_by_users_id_fk"
      FOREIGN KEY ("cancelled_by")
      REFERENCES "tenant"."users"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION;
  END IF;
END $$;
