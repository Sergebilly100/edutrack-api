ALTER TABLE public.school_sms_features
  ADD COLUMN IF NOT EXISTS student_assignment_enabled boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "tenant"."student_lifecycle_status" AS ENUM ('active', 'expelled', 'transferred');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "tenant"."student_document_status" AS ENUM ('missing', 'provided', 'to_renew');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "tenant"."enrollment_type" AS ENUM ('new_registration', 're_registration');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "tenant"."enrollment_status" AS ENUM ('pending_cashier', 'pending_dossier', 'confirmed', 'blocked_unpaid');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
ALTER TABLE "tenant"."students" ADD COLUMN IF NOT EXISTS "is_assigned" boolean;
--> statement-breakpoint
ALTER TABLE "tenant"."students" ADD COLUMN IF NOT EXISTS "lifecycle_status" "tenant"."student_lifecycle_status" DEFAULT 'active' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."required_document_types" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "level_id" uuid NOT NULL REFERENCES "tenant"."levels"("id") ON DELETE CASCADE,
  "name" varchar(150) NOT NULL,
  "is_mandatory" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "required_document_types_level_name_unique" UNIQUE ("level_id", "name")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_required_document_types_level" ON "tenant"."required_document_types" ("level_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."student_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "document_type_id" uuid NOT NULL REFERENCES "tenant"."required_document_types"("id") ON DELETE CASCADE,
  "status" "tenant"."student_document_status" DEFAULT 'missing' NOT NULL,
  "file_url" text,
  "r2_key" varchar(500),
  "provided_at" timestamp with time zone,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "student_documents_student_type_unique" UNIQUE ("student_id", "document_type_id"),
  CONSTRAINT "student_documents_provided_file_check" CHECK ("status" <> 'provided' OR "r2_key" IS NOT NULL OR "file_url" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_student_documents_student" ON "tenant"."student_documents" ("student_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."enrollments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "class_id" uuid NOT NULL REFERENCES "tenant"."classes"("id"),
  "school_year_id" uuid NOT NULL REFERENCES "tenant"."school_years"("id"),
  "type" "tenant"."enrollment_type" NOT NULL,
  "status" "tenant"."enrollment_status" NOT NULL,
  "enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
  "confirmed_by_user_id" uuid REFERENCES "tenant"."users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "enrollments_student_year_unique" UNIQUE ("student_id", "school_year_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_enrollments_year_status" ON "tenant"."enrollments" ("school_year_id", "status");
