ALTER TYPE "tenant"."notification_type"
  ADD VALUE IF NOT EXISTS 'parent_access_credentials';
--> statement-breakpoint

ALTER TABLE "tenant"."parents"
  ADD COLUMN IF NOT EXISTS "access_sent_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "tenant"."parent_student_links"
  ALTER COLUMN "subscription_id" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "tenant"."parent_student_links"
  DROP CONSTRAINT IF EXISTS "parent_student_links_subscription_id_parent_subscriptions_id_fk";
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'parent_student_links_subscription_id_parent_subscriptions_id_fk'
      AND conrelid = '"tenant"."parent_student_links"'::regclass
  ) THEN
    ALTER TABLE "tenant"."parent_student_links"
      ADD CONSTRAINT "parent_student_links_subscription_id_parent_subscriptions_id_fk"
      FOREIGN KEY ("subscription_id")
      REFERENCES "tenant"."parent_subscriptions"("id")
      ON DELETE SET NULL;
  END IF;
END
$$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_parents_access_pending"
  ON "tenant"."parents" ("created_at")
  WHERE "access_sent_at" IS NULL;
