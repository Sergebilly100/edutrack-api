ALTER TABLE "tenant"."student_tuition_schedule_agreements" DROP CONSTRAINT IF EXISTS "student_tuition_schedule_agreements_student_year_unique";--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD COLUMN "closed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD COLUMN "closure_reason" text;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD COLUMN "replaced_by_agreement_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD CONSTRAINT "student_tuition_schedule_agreements_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "student_tuition_schedule_agreements_active_student_year_unique" ON "tenant"."student_tuition_schedule_agreements" USING btree ("student_id","school_year_id") WHERE "tenant"."student_tuition_schedule_agreements"."status" = 'active';--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD CONSTRAINT "student_tuition_schedule_agreements_status" CHECK ("tenant"."student_tuition_schedule_agreements"."status" IN ('active', 'replaced', 'reset'));
