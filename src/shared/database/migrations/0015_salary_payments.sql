CREATE TABLE "tenant"."salary_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "salary_record_id" uuid NOT NULL,
  "hours_paid" numeric(6, 2),
  "amount_fcfa" integer NOT NULL,
  "notes" text,
  "paid_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paid_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant"."salary_payments" ADD CONSTRAINT "salary_payments_salary_record_id_salary_records_id_fk" FOREIGN KEY ("salary_record_id") REFERENCES "tenant"."salary_records"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant"."salary_payments" ADD CONSTRAINT "salary_payments_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_salary_payments_record_paid_at" ON "tenant"."salary_payments" USING btree ("salary_record_id", "paid_at");
