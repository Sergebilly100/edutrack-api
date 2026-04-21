ALTER TABLE "tenant"."students" ADD COLUMN IF NOT EXISTS "matricule" varchar(50);--> statement-breakpoint
ALTER TABLE "tenant"."students" ADD COLUMN IF NOT EXISTS "birth_date" date;--> statement-breakpoint
ALTER TABLE "tenant"."teachers" ADD COLUMN IF NOT EXISTS "matricule" varchar(50);--> statement-breakpoint
ALTER TABLE "tenant"."teachers" ADD COLUMN IF NOT EXISTS "monthly_salary" integer;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'teachers_monthly_salary_non_negative'
  ) THEN
    ALTER TABLE "tenant"."teachers"
      ADD CONSTRAINT "teachers_monthly_salary_non_negative"
      CHECK ("tenant"."teachers"."monthly_salary" IS NULL OR "tenant"."teachers"."monthly_salary" >= 0);
  END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teachers_matricule_unique" ON "tenant"."teachers" USING btree ("matricule");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "students_matricule_unique" ON "tenant"."students" USING btree ("matricule");
