import { sql, type SQL } from 'drizzle-orm';

/** Une classe enseignée est liée au professeur par une affectation ou un créneau actif. */
export const teacherClassRelation = (teacherId: SQL, classId: SQL) => sql`(
  EXISTS (SELECT 1 FROM teacher_subject_assignments tsa
    WHERE tsa.teacher_id = ${teacherId} AND tsa.class_id = ${classId})
  OR EXISTS (SELECT 1 FROM schedules sch
    WHERE sch.teacher_id = ${teacherId} AND sch.class_id = ${classId} AND sch.is_active = true)
)`;
