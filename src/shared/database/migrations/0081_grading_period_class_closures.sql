CREATE TABLE IF NOT EXISTS "tenant"."grading_period_class_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grading_period_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grading_period_class_closure_unique" UNIQUE("grading_period_id","class_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tenant"."grading_period_class_closures" ADD CONSTRAINT "grading_period_class_closures_grading_period_id_grading_periods_id_fk" FOREIGN KEY ("grading_period_id") REFERENCES "tenant"."grading_periods"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tenant"."grading_period_class_closures" ADD CONSTRAINT "grading_period_class_closures_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "tenant"."classes"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Preserve reviews that were already complete. The stored class_headcount is
-- the confirmed cohort size at generation; only currently confirmed cards count.
WITH card_progress AS (
  SELECT rc.grading_period_id, rc.class_id,
         COUNT(DISTINCT rc.student_id)::int AS card_count,
         MIN(rc.class_headcount)::int AS cohort_size
  FROM "tenant"."report_cards" rc
  INNER JOIN "tenant"."grading_periods" gp ON gp.id = rc.grading_period_id
  INNER JOIN "tenant"."classes" c ON c.id = rc.class_id AND c.school_year_id = gp.school_year_id
  WHERE rc.status IN ('generated', 'published')
    AND EXISTS (
      SELECT 1 FROM "tenant"."enrollments" e
      INNER JOIN "tenant"."students" s ON s.id = e.student_id AND s.is_active = true
      WHERE e.student_id = rc.student_id AND e.class_id = rc.class_id
        AND e.school_year_id = gp.school_year_id AND e.status = 'confirmed'
    )
  GROUP BY rc.grading_period_id, rc.class_id
)
INSERT INTO "tenant"."grading_period_class_closures" (grading_period_id, class_id)
SELECT grading_period_id, class_id FROM card_progress
WHERE cohort_size > 0 AND card_count >= cohort_size
ON CONFLICT (grading_period_id, class_id) DO NOTHING;
