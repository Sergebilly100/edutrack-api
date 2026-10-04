import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryTenant, request } from './setup.js';

type ComplianceItem = {
  teacherId: string;
  totalScheduled: number;
  hasScheduledLessons: boolean;
  totalCheckins: number;
  complianceRate: number;
  scanEndRate: number;
  roomCorrectRate: number;
  rollcallRate: number;
  attendanceRate: number;
  rank: number;
};

const MONTH = '2088-04';
const DATE = '2088-04-01';

const getCompliance = async (subject?: string): Promise<ComplianceItem[]> => {
  const headers = await getAuthHeaders('director');
  const response = await request()
    .get(`/api/v1/attendance/teacher-compliance?month=${MONTH}${subject ? `&subject=${encodeURIComponent(subject)}` : ''}`)
    .set(headers);
  expect(response.status).toBe(200);
  return response.body as ComplianceItem[];
};

const seedTeacher = async (name: string, subject: string): Promise<string> => {
  const [user] = await queryTenant<{ id: string }>(
    `INSERT INTO users (role, name, password_hash, is_active)
     VALUES ('teacher', $1, 'not-used', true) RETURNING id::text`, [name]
  );
  const [teacher] = await queryTenant<{ id: string }>(
    `INSERT INTO teachers (user_id, username, type, subjects, hourly_rate)
     VALUES ($1::uuid, $2, 'vacataire', ARRAY[$3]::text[], 5000) RETURNING id::text`,
    [user!.id, `c32.${name.toLowerCase().replaceAll(' ', '.')}`, subject]
  );
  return teacher!.id;
};

const seedSchedule = async (teacherId: string, sourceScheduleId: string, periodId: string): Promise<string> => {
  const [schedule] = await queryTenant<{ id: string }>(
    `INSERT INTO schedules
       (schedule_period_id, teacher_id, class_id, room_id, time_slot_id, day_of_week, subject, is_active)
     SELECT $1::uuid, $2::uuid, class_id, room_id, time_slot_id,
       EXTRACT(ISODOW FROM $3::date)::int, 'Mathematiques', true
     FROM schedules WHERE id = $4::uuid RETURNING id::text`,
    [periodId, teacherId, DATE, sourceScheduleId]
  );
  return schedule!.id;
};

describe('GET /api/v1/attendance/teacher-compliance', () => {
  it('retourne 100 pour un mois sans cours, avec et sans filtre matière', async () => {
    const teacherId = getSeedContext().teacherId;
    const all = await getCompliance();
    const teacher = all.find((row) => row.teacherId === teacherId);
    expect(teacher).toMatchObject({
      totalScheduled: 0,
      hasScheduledLessons: false,
      totalCheckins: 0,
      complianceRate: 100,
      scanEndRate: 100,
      roomCorrectRate: 100,
      rollcallRate: 100,
      attendanceRate: 100,
    });
    expect((await getCompliance('Mathematiques')).some((row) => row.teacherId === teacherId)).toBe(true);
    expect((await getCompliance('SVT')).some((row) => row.teacherId === teacherId)).toBe(false);

    const teacherResponse = await request()
      .get(`/api/v1/attendance/teacher-compliance?month=${MONTH}`)
      .set(await getAuthHeaders('teacher'));
    expect(teacherResponse.status).toBe(200);
    expect(teacherResponse.body).toEqual([expect.objectContaining({
      teacherId, totalScheduled: 0, hasScheduledLessons: false, complianceRate: 100,
    })]);
  });

  it('classe un cours sans pointage à 0 et un cours complet à 100, sans inclure les autres matières', async () => {
    const context = getSeedContext();
    const completeTeacherId = await seedTeacher('C32 Complet', 'Mathematiques');
    const unscheduledTeacherId = await seedTeacher('C32 Sans Cours', 'SVT');
    const [period] = await queryTenant<{ id: string }>(
      `INSERT INTO schedule_periods (name, valid_from, valid_to, is_active)
       VALUES ('C32 Avril 2088', $1::date, $1::date, true) RETURNING id::text`, [DATE]
    );
    await seedSchedule(context.teacherId, context.scheduleId, period!.id);
    const completeScheduleId = await seedSchedule(completeTeacherId, context.scheduleId, period!.id);
    await queryTenant(
      `INSERT INTO attendances_teacher
         (teacher_id, schedule_id, date, status, checked_in_at, checked_out_at, room_mismatch)
       VALUES ($1::uuid, $2::uuid, $3::date, 'present',
         $3::date + time '08:00', $3::date + time '09:00', false)`,
      [completeTeacherId, completeScheduleId, DATE]
    );
    const [student] = await queryTenant<{ id: string }>(
      `INSERT INTO students (first_name, last_name) VALUES ('C32', 'Eleve') RETURNING id::text`
    );
    await queryTenant(
      `INSERT INTO attendances_student (student_id, schedule_id, date, status)
       VALUES ($1::uuid, $2::uuid, $3::date, 'present')`,
      [student!.id, completeScheduleId, DATE]
    );

    const all = await getCompliance();
    const empty = all.find((row) => row.teacherId === unscheduledTeacherId);
    const complete = all.find((row) => row.teacherId === completeTeacherId);
    const missing = all.find((row) => row.teacherId === context.teacherId);
    expect(empty).toMatchObject({ totalScheduled: 0, hasScheduledLessons: false, complianceRate: 100 });
    expect(complete).toMatchObject({ totalScheduled: 1, hasScheduledLessons: true, complianceRate: 100,
      scanEndRate: 100, roomCorrectRate: 100, rollcallRate: 100, attendanceRate: 100 });
    expect(missing).toMatchObject({ totalScheduled: 1, hasScheduledLessons: true, totalCheckins: 0, complianceRate: 0 });
    expect(complete!.rank).toBeLessThan(missing!.rank);
    for (const row of all) {
      for (const rate of [row.complianceRate, row.scanEndRate, row.roomCorrectRate, row.rollcallRate, row.attendanceRate]) {
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(100);
      }
    }

    const maths = await getCompliance('Mathematiques');
    expect(maths.map((row) => row.teacherId)).toEqual(expect.arrayContaining([context.teacherId, completeTeacherId]));
    expect(maths.some((row) => row.teacherId === unscheduledTeacherId)).toBe(false);
    const svt = await getCompliance('SVT');
    expect(svt.find((row) => row.teacherId === unscheduledTeacherId)).toMatchObject({
      totalScheduled: 0, hasScheduledLessons: false, complianceRate: 100,
    });
    expect(svt.some((row) => row.teacherId === context.teacherId || row.teacherId === completeTeacherId)).toBe(false);
  });
});
