CREATE TYPE "tenant"."document_entity_type" AS ENUM('teacher', 'student');--> statement-breakpoint
CREATE TYPE "tenant"."salary_status" AS ENUM('pending', 'paid', 'disputed');--> statement-breakpoint
CREATE TABLE "tenant"."admin_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" "tenant"."document_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"type" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"r2_key" varchar(500) NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant"."position_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_assignments_user_position_unique" UNIQUE("user_id","position_id")
);
--> statement-breakpoint
CREATE TABLE "tenant"."salary_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"hours_planned" numeric(6, 2) NOT NULL,
	"hours_done" numeric(6, 2) NOT NULL,
	"hourly_rate" integer NOT NULL,
	"total_fcfa" integer NOT NULL,
	"status" "tenant"."salary_status" DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_by" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_records_teacher_period_month_unique" UNIQUE("teacher_id","period_month")
);
--> statement-breakpoint
ALTER TABLE "tenant"."students" ADD COLUMN "parent_name" varchar(255);--> statement-breakpoint
ALTER TABLE "tenant"."students" ADD COLUMN "parent_name_2" varchar(255);--> statement-breakpoint
ALTER TABLE "tenant"."students" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "tenant"."teachers" ADD COLUMN "is_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant"."teachers" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "tenant"."teachers" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant"."admin_positions" ADD CONSTRAINT "admin_positions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."position_assignments" ADD CONSTRAINT "position_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "tenant"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."position_assignments" ADD CONSTRAINT "position_assignments_position_id_admin_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "tenant"."admin_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."position_assignments" ADD CONSTRAINT "position_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."salary_records" ADD CONSTRAINT "salary_records_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "tenant"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."salary_records" ADD CONSTRAINT "salary_records_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_positions_created_by" ON "tenant"."admin_positions" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_documents_entity" ON "tenant"."documents" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_salary_teacher_month" ON "tenant"."salary_records" USING btree ("teacher_id","period_month");
