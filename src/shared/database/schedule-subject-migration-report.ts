import type { PoolClient } from 'pg';

export type UnresolvedScheduleSubject = {
  scheduleId: string;
  classId: string;
  teacherId: string;
  historicalLabel: string;
  activeOrFuture: boolean;
};

export const unresolvedScheduleSubjects = async (
  client: PoolClient, schemaName: string,
): Promise<UnresolvedScheduleSubject[]> => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) throw new Error('Invalid tenant schema name');
  const result = await client.query<{
    schedule_id: string; class_id: string; teacher_id: string;
    historical_label: string; active_or_future: boolean;
  }>(`
    SELECT sch.id::text AS schedule_id, sch.class_id::text, sch.teacher_id::text,
           sch.subject AS historical_label,
           (sch.is_active AND sp.valid_to >= CURRENT_DATE
             AND (sch.end_date IS NULL OR sch.end_date > CURRENT_DATE)) AS active_or_future
    FROM "${schemaName}"."schedules" sch
    INNER JOIN "${schemaName}"."schedule_periods" sp ON sp.id = sch.schedule_period_id
    WHERE sch.subject_id IS NULL
    ORDER BY active_or_future DESC, sch.id
  `);
  return result.rows.map((row) => ({
    scheduleId: row.schedule_id,
    classId: row.class_id,
    teacherId: row.teacher_id,
    historicalLabel: row.historical_label,
    activeOrFuture: row.active_or_future,
  }));
};
