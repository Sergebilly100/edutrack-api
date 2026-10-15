ALTER TABLE "tenant"."payments" DROP CONSTRAINT "payments_cancellation_consistent";--> statement-breakpoint
ALTER TABLE "tenant"."payments" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "tenant"."finance_payment_status";--> statement-breakpoint
CREATE TYPE "tenant"."finance_payment_status" AS ENUM('confirmed', 'cancelled');--> statement-breakpoint
ALTER TABLE "tenant"."payments" ALTER COLUMN "status" SET DATA TYPE "tenant"."finance_payment_status" USING "status"::"tenant"."finance_payment_status";--> statement-breakpoint
ALTER TABLE "tenant"."student_financial_status" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "tenant"."financial_cache_status";--> statement-breakpoint
CREATE TYPE "tenant"."financial_cache_status" AS ENUM('up_to_date', 'late');--> statement-breakpoint
ALTER TABLE "tenant"."student_financial_status" ALTER COLUMN "status" SET DATA TYPE "tenant"."financial_cache_status" USING "status"::"tenant"."financial_cache_status";--> statement-breakpoint
CREATE INDEX "idx_payments_confirmed_student_year" ON "tenant"."payments" USING btree ("student_id","school_year_id") WHERE "tenant"."payments"."status" = 'confirmed';--> statement-breakpoint
ALTER TABLE "tenant"."student_financial_status" DROP COLUMN "waived_amount";--> statement-breakpoint
ALTER TABLE "tenant"."payments" ADD CONSTRAINT "payments_cancellation_consistent" CHECK (("tenant"."payments"."status"::text <> 'cancelled' AND "tenant"."payments"."cancelled_at" IS NULL AND "tenant"."payments"."cancelled_by_user_id" IS NULL AND "tenant"."payments"."cancellation_reason" IS NULL) OR ("tenant"."payments"."status"::text = 'cancelled' AND "tenant"."payments"."cancelled_at" IS NOT NULL AND "tenant"."payments"."cancelled_by_user_id" IS NOT NULL AND length(btrim("tenant"."payments"."cancellation_reason")) > 0));