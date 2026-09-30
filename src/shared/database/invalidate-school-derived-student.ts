import { sql } from 'drizzle-orm';

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/** Clear only recalculable academic and risk snapshots after confirmation. */
export const invalidateSchoolDerivedStudent = async (
  db: Executor,
  studentId: string,
  schoolYearId: string
): Promise<void> => {
  await db.execute(sql`
    DELETE FROM student_period_averages spa
    WHERE spa.student_id = ${studentId}::uuid
      AND EXISTS (SELECT 1 FROM grading_periods gp
        WHERE gp.id = spa.grading_period_id AND gp.school_year_id = ${schoolYearId}::uuid)
  `);
  await db.execute(sql`DELETE FROM student_risk_status WHERE student_id = ${studentId}::uuid`);
};
