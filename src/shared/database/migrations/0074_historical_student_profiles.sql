-- C7: retain the legacy column, without assigning a class to historical profiles.
ALTER TABLE "tenant"."students" ALTER COLUMN "class_id" DROP NOT NULL;
--> statement-breakpoint
-- Enrollment wins even when the retained legacy class is stale. Pending enrollments
-- never contribute a class. The fallback preserves V1 records without enrollments.
CREATE OR REPLACE VIEW "tenant"."students_with_class" AS
SELECT s.id,
       COALESCE(enrolled.class_id, CASE WHEN NOT EXISTS (
         SELECT 1 FROM "tenant"."enrollments" e
         JOIN "tenant"."classes" legacy_class ON legacy_class.id = s.class_id
         WHERE e.student_id = s.id AND e.school_year_id = legacy_class.school_year_id
       ) THEN s.class_id END) AS class_id,
       s.matricule, s.first_name, s.last_name, s.birth_date,
       s.parent_name, s.parent_phone, s.parent_email, s.parent_name_2, s.parent_phone_2,
       s.notes, s.is_active, s.created_at, s.is_assigned, s.lifecycle_status
FROM "tenant"."students" s
LEFT JOIN LATERAL (
  SELECT e.class_id
  FROM "tenant"."enrollments" e
  INNER JOIN "tenant"."school_years" sy ON sy.id = e.school_year_id
  WHERE e.student_id = s.id AND e.status = 'confirmed'
  ORDER BY (sy.status = 'active') DESC, sy.start_date DESC, e.enrolled_at DESC
  LIMIT 1
) enrolled ON true;
