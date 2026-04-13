CREATE SCHEMA "tenant";
--> statement-breakpoint
CREATE TYPE "tenant"."attendance_student_status" AS ENUM('present', 'absent', 'excused');--> statement-breakpoint
CREATE TYPE "tenant"."attendance_teacher_status" AS ENUM('present', 'absent', 'late', 'excused');--> statement-breakpoint
CREATE TYPE "tenant"."notification_status" AS ENUM('queued', 'sent', 'failed', 'delivered');--> statement-breakpoint
CREATE TYPE "tenant"."notification_type" AS ENUM('teacher_absent_director', 'teacher_late_director', 'teacher_qr_mismatch', 'teacher_qr_missing_scan', 'teacher_qr_scan_out_of_time', 'student_absent_parent', 'payment_reminder', 'custom');--> statement-breakpoint
CREATE TYPE "tenant"."teacher_type" AS ENUM('vacataire', 'permanent');--> statement-breakpoint
CREATE TYPE "tenant"."user_role" AS ENUM('director', 'secretary', 'teacher', 'super_admin');--> statement-breakpoint
CREATE TABLE "tenant"."attendances_student" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"schedule_id" uuid,
	"date" date NOT NULL,
	"status" "tenant"."attendance_student_status" DEFAULT 'absent' NOT NULL,
	"marked_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendances_student_student_schedule_date_unique" UNIQUE("student_id","schedule_id","date")
);
--> statement-breakpoint
CREATE TABLE "tenant"."attendances_teacher" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"schedule_id" uuid,
	"date" date NOT NULL,
	"status" "tenant"."attendance_teacher_status" DEFAULT 'present' NOT NULL,
	"checked_in_at" timestamp with time zone,
	"late_minutes" integer,
	"room_scanned_id" uuid,
	"room_scan_start_at" timestamp with time zone,
	"room_scan_end_at" timestamp with time zone,
	"room_mismatch" boolean DEFAULT false NOT NULL,
	"qr_alert_sent" boolean DEFAULT false NOT NULL,
	"marked_by" uuid,
	"synced_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendances_teacher_teacher_schedule_date_unique" UNIQUE("teacher_id","schedule_id","date")
);
--> statement-breakpoint
CREATE TABLE "tenant"."classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"level" varchar(50),
	"student_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant"."notifications_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "tenant"."notification_type" NOT NULL,
	"recipient_phone" varchar(20) NOT NULL,
	"message" text NOT NULL,
	"status" "tenant"."notification_status" DEFAULT 'queued' NOT NULL,
	"provider_ref" varchar(255),
	"related_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant"."rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"qr_token" varchar(64) NOT NULL,
	"building" varchar(100),
	"capacity" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_qr_token_unique" UNIQUE("qr_token")
);
--> statement-breakpoint
CREATE TABLE "tenant"."schedule_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_periods_valid_period_range" CHECK ("tenant"."schedule_periods"."valid_from" <= "tenant"."schedule_periods"."valid_to")
);
--> statement-breakpoint
CREATE TABLE "tenant"."schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_period_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"time_slot_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"subject" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_period_teacher_slot_day_unique" UNIQUE("schedule_period_id","teacher_id","time_slot_id","day_of_week"),
	CONSTRAINT "schedules_day_of_week_range" CHECK ("tenant"."schedules"."day_of_week" BETWEEN 1 AND 6)
);
--> statement-breakpoint
CREATE TABLE "tenant"."students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"parent_phone" varchar(20),
	"parent_phone_2" varchar(20),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant"."teachers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"username" varchar(50) NOT NULL,
	"type" "tenant"."teacher_type" NOT NULL,
	"subjects" text[] DEFAULT '{}'::text[] NOT NULL,
	"hourly_rate" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teachers_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "tenant"."time_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(50) NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "time_slots_valid_time_range" CHECK ("tenant"."time_slots"."start_time" < "tenant"."time_slots"."end_time")
);
--> statement-breakpoint
CREATE TABLE "tenant"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "tenant"."user_role" NOT NULL,
	"name" varchar(255) NOT NULL,
	"phone" varchar(20),
	"email" varchar(255),
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "tenant"."attendances_student" ADD CONSTRAINT "attendances_student_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "tenant"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."attendances_student" ADD CONSTRAINT "attendances_student_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "tenant"."schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."attendances_student" ADD CONSTRAINT "attendances_student_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."attendances_teacher" ADD CONSTRAINT "attendances_teacher_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "tenant"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."attendances_teacher" ADD CONSTRAINT "attendances_teacher_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "tenant"."schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."attendances_teacher" ADD CONSTRAINT "attendances_teacher_room_scanned_id_rooms_id_fk" FOREIGN KEY ("room_scanned_id") REFERENCES "tenant"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."attendances_teacher" ADD CONSTRAINT "attendances_teacher_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."schedule_periods" ADD CONSTRAINT "schedule_periods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."schedules" ADD CONSTRAINT "schedules_schedule_period_id_schedule_periods_id_fk" FOREIGN KEY ("schedule_period_id") REFERENCES "tenant"."schedule_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."schedules" ADD CONSTRAINT "schedules_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "tenant"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."schedules" ADD CONSTRAINT "schedules_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "tenant"."classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."schedules" ADD CONSTRAINT "schedules_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "tenant"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."schedules" ADD CONSTRAINT "schedules_time_slot_id_time_slots_id_fk" FOREIGN KEY ("time_slot_id") REFERENCES "tenant"."time_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."students" ADD CONSTRAINT "students_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "tenant"."classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."teachers" ADD CONSTRAINT "teachers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "tenant"."users"("id") ON DELETE cascade ON UPDATE no action;