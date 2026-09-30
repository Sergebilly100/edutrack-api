import { sql, type SQL } from 'drizzle-orm';

/**
 * School population contract, shared with finance. The caller supplies the
 * requested school year and, for a class-scoped operation, its class id.
 * EXISTS prevents duplicate legacy enrollments from duplicating a student.
 * This deliberately never reads students.class_id or students_with_class.
 */
export const confirmedSchoolStudent = (
  studentId: SQL,
  schoolYearId: SQL,
  classId?: SQL,
  requireActiveClass = true
): SQL => sql`EXISTS (
  SELECT 1
  FROM enrollments membership_enrollment
  INNER JOIN students membership_student
    ON membership_student.id = membership_enrollment.student_id
   AND membership_student.is_active = true
  INNER JOIN classes membership_class
    ON membership_class.id = membership_enrollment.class_id
   AND membership_class.school_year_id = membership_enrollment.school_year_id
   ${requireActiveClass ? sql`AND membership_class.is_active = true` : sql``}
  WHERE membership_enrollment.student_id = ${studentId}
    AND membership_enrollment.school_year_id = ${schoolYearId}
    AND membership_enrollment.status = 'confirmed'
    ${classId ? sql`AND membership_enrollment.class_id = ${classId}` : sql``}
)`;

/** Class count starts at the year/status enrollment index, then reuses the contract above. */
export const confirmedSchoolClassCount = (classId: SQL, schoolYearId: SQL): SQL => sql`(
  SELECT COUNT(DISTINCT counted_enrollment.student_id)::int
  FROM enrollments counted_enrollment
  WHERE counted_enrollment.class_id = ${classId}
    AND counted_enrollment.school_year_id = ${schoolYearId}
    AND counted_enrollment.status = 'confirmed'
    AND ${confirmedSchoolStudent(sql`counted_enrollment.student_id`, schoolYearId, classId)}
)`;
