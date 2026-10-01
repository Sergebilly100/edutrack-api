CREATE TABLE IF NOT EXISTS "tenant"."conduct_grade_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conduct_grade_id" uuid NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"old_note" numeric(5, 2),
	"new_note" numeric(5, 2) NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."conduct_policy_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_year_id" uuid NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"old_mode" varchar(24) NOT NULL,
	"new_mode" varchar(24) NOT NULL,
	"old_coefficient" numeric(8, 3) NOT NULL,
	"new_coefficient" numeric(8, 3) NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant"."school_years" ADD COLUMN IF NOT EXISTS "conduct_decision_mode" varchar(24) DEFAULT 'homeroom' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant"."school_years" ADD COLUMN IF NOT EXISTS "conduct_coefficient" numeric(8, 3) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant"."conduct_grade_audit" ADD CONSTRAINT "conduct_grade_audit_conduct_grade_id_conduct_grades_id_fk" FOREIGN KEY ("conduct_grade_id") REFERENCES "tenant"."conduct_grades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."conduct_grade_audit" ADD CONSTRAINT "conduct_grade_audit_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."conduct_policy_audit" ADD CONSTRAINT "conduct_policy_audit_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "tenant"."school_years"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."conduct_policy_audit" ADD CONSTRAINT "conduct_policy_audit_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."school_years" ADD CONSTRAINT "school_years_conduct_mode" CHECK ("tenant"."school_years"."conduct_decision_mode" IN ('homeroom', 'direction', 'delegated'));--> statement-breakpoint
ALTER TABLE "tenant"."school_years" ADD CONSTRAINT "school_years_conduct_coefficient_positive" CHECK ("tenant"."school_years"."conduct_coefficient" > 0);