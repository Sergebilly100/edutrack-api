ALTER TABLE "tenant"."student_tuition_overrides" DROP CONSTRAINT "student_tuition_overrides_student_year_unique";--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_overrides" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_overrides" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_overrides" ADD COLUMN "withdrawn_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_overrides" ADD COLUMN "withdrawal_reason" text;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_overrides" ADD CONSTRAINT "student_tuition_overrides_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "student_tuition_overrides_active_student_year_unique" ON "tenant"."student_tuition_overrides" USING btree ("student_id","school_year_id") WHERE "tenant"."student_tuition_overrides"."status" = 'active';--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_overrides" ADD CONSTRAINT "student_tuition_overrides_status" CHECK ("tenant"."student_tuition_overrides"."status" IN ('active', 'withdrawn'));