import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { AttendanceRepository } from '../../src/modules/attendance/attendance.repository.js';

const dialect = new PgDialect();
const weekRow = {
  id: 'slot-1', class_id: 'class-1', class_name: '6ème A', subject: 'Mathématiques',
  subject_id: null, level_subjects: [], room_id: 'room-1', room_name: 'Salle 1',
  day_of_week: 2, start_time: '08:00:00', end_time: '09:00:00',
};

describe('créneaux hebdomadaires enseignant', () => {
  it('charge les créneaux même si la migration subject_id est encore absente', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ present: false }] })
      .mockResolvedValueOnce({ rows: [weekRow] });
    const repository = new AttendanceRepository({ execute } as unknown as ConstructorParameters<typeof AttendanceRepository>[0]);

    const slots = await repository.getWeekScheduleForTeacher('teacher-user', '2026-10-13');

    expect(slots).toEqual([weekRow]);
    const query = dialect.sqlToQuery(execute.mock.calls[1]![0]).sql;
    expect(query).toContain('NULL::text AS subject_id');
    expect(query).not.toContain('s.subject_id');
  });

  it('utilise la matière officielle ou sa correspondance unique après migration', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({ rows: [{ ...weekRow, subject_id: 'subject-1' }] });
    const repository = new AttendanceRepository({ execute } as unknown as ConstructorParameters<typeof AttendanceRepository>[0]);

    const slots = await repository.getWeekScheduleForTeacher('teacher-user', '2026-10-13');

    expect(slots[0]?.subject_id).toBe('subject-1');
    const query = dialect.sqlToQuery(execute.mock.calls[1]![0]).sql;
    expect(query).toContain('COALESCE(s.subject_id, inferred_subject.id)::text AS subject_id');
  });
});
