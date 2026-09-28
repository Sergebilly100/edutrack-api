import { sql, type SQL } from 'drizzle-orm';

/** The only membership rule for a student's financial year. */
export const confirmedFinancialStudent = (studentId: SQL, schoolYearId: SQL): SQL => sql`
  EXISTS (
    SELECT 1 FROM enrollments financial_enrollment
    INNER JOIN students financial_student
      ON financial_student.id = financial_enrollment.student_id
     AND financial_student.is_active = true
    INNER JOIN classes financial_class
      ON financial_class.id = financial_enrollment.class_id
     AND financial_class.is_active = true
     AND financial_class.school_year_id = financial_enrollment.school_year_id
    WHERE financial_enrollment.student_id = ${studentId}
      AND financial_enrollment.school_year_id = ${schoolYearId}
      AND financial_enrollment.status = 'confirmed'
  )
`;
