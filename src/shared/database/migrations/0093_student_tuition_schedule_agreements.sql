CREATE TABLE "tenant"."student_tuition_schedule_agreements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL,
  "school_year_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "student_tuition_schedule_agreements_student_year_unique" UNIQUE("student_id", "school_year_id")
);--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_steps" ADD COLUMN "agreement_id" uuid;--> statement-breakpoint
INSERT INTO "tenant"."student_tuition_schedule_agreements" (
  "student_id", "school_year_id", "reason", "created_at", "updated_at"
)
SELECT "student_id", "school_year_id", 'Échéancier historique migré', MIN("created_at"), MAX("updated_at")
FROM "tenant"."student_tuition_schedule_steps"
GROUP BY "student_id", "school_year_id";--> statement-breakpoint
UPDATE "tenant"."student_tuition_schedule_steps" AS step
SET "agreement_id" = agreement."id"
FROM "tenant"."student_tuition_schedule_agreements" AS agreement
WHERE agreement."student_id" = step."student_id"
  AND agreement."school_year_id" = step."school_year_id";--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_steps" ALTER COLUMN "agreement_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_steps" DROP CONSTRAINT "student_tuition_schedule_steps_student_year_date_unique";--> statement-breakpoint
DROP INDEX "tenant"."idx_student_tuition_schedule_steps_student_year_due_date";--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD CONSTRAINT "student_tuition_schedule_agreements_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "tenant"."students"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD CONSTRAINT "student_tuition_schedule_agreements_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "tenant"."school_years"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD CONSTRAINT "student_tuition_schedule_agreements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "tenant"."users"("id");--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_agreements" ADD CONSTRAINT "student_tuition_schedule_agreements_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "tenant"."users"("id");--> statement-breakpoint
CREATE INDEX "idx_student_tuition_schedule_agreements_year" ON "tenant"."student_tuition_schedule_agreements" USING btree ("school_year_id");--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_steps" ADD CONSTRAINT "student_tuition_schedule_steps_agreement_id_student_tuition_schedule_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "tenant"."student_tuition_schedule_agreements"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "idx_student_tuition_schedule_steps_agreement_due_date" ON "tenant"."student_tuition_schedule_steps" USING btree ("agreement_id", "due_date");--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_steps" DROP COLUMN "student_id";--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_steps" DROP COLUMN "school_year_id";--> statement-breakpoint
ALTER TABLE "tenant"."student_tuition_schedule_steps" ADD CONSTRAINT "student_tuition_schedule_steps_agreement_date_unique" UNIQUE("agreement_id", "due_date");
