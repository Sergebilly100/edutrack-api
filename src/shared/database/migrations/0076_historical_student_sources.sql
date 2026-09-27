-- Historical year/class references only: no enrollment, class, parent account or financial entry.
CREATE TABLE IF NOT EXISTS "tenant"."student_historical_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"school_year_label" varchar(9) NOT NULL,
	"old_class_name" varchar(100),
	"row_key" varchar(64) NOT NULL,
	"import_history_id" uuid NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_sources_student_year_unique" UNIQUE("student_id","school_year_label"),
	CONSTRAINT "historical_sources_row_year_unique" UNIQUE("school_year_label","row_key")
);

--> statement-breakpoint
ALTER TABLE "tenant"."import_history" ADD COLUMN IF NOT EXISTS "historical_school_year_label" varchar(9);
--> statement-breakpoint
DO $c7$ BEGIN ALTER TABLE "tenant"."student_historical_sources" ADD CONSTRAINT "student_historical_sources_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "tenant"."students"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $c7$;
--> statement-breakpoint
DO $c7$ BEGIN ALTER TABLE "tenant"."student_historical_sources" ADD CONSTRAINT "student_historical_sources_import_history_id_import_history_id_fk" FOREIGN KEY ("import_history_id") REFERENCES "tenant"."import_history"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $c7$;
