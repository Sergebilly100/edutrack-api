import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable } from './setup.js';

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
};

const isoDayOfWeek = (isoDate: string): number => {
  const day = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

const monthBounds = (month: string): { start: string; end: string } => {
  const [year, monthPart] = month.split('-').map((value) => Number(value));
  const start = `${month}-01`;
  const end = toIsoDate(new Date(Date.UTC(year ?? 1970, monthPart ?? 1, 0)));
  return { start, end };
};

const buildUniqueSuffix = (): string => `${Date.now()}_${Math.floor(Math.random() * 10_000)}`;

const findFirstWeekdayInRange = (startIso: string, endIso: string): string | null => {
  const start = new Date(`${startIso}T00:00:00.000Z`);
  const end = new Date(`${endIso}T00:00:00.000Z`);

  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 6) {
      return toIsoDate(cursor);
    }
  }

  return null;
};

const mondayForIsoDate = (isoDate: string): string => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const isoDay = day === 0 ? 7 : day;
  date.setUTCDate(date.getUTCDate() - (isoDay - 1));
  return toIsoDate(date);
};

const createScheduleFixture = async (input: {
  teacherId: string;
  classId: string;
  roomId: string;
  dayOfWeek: number;
  validFrom: string;
  validTo: string;
  subject: string;
  endDate?: string | null;
}): Promise<{
  scheduleId: string;
  schedulePeriodId: string;
  timeSlotId: string;
  dayOfWeek: number;
}> => {
  const suffix = buildUniqueSuffix();
  const period = await queryTenant<{ id: string }>(
    `
      INSERT INTO ${tenantTable('schedule_periods')} (name, valid_from, valid_to, is_active, created_by)
      VALUES ($1, $2::date, $3::date, true, NULL)
      RETURNING id
    `,
    [`History period ${suffix}`, input.validFrom, input.validTo]
  );
  const schedulePeriodId = period[0]?.id;
  if (!schedulePeriodId) {
    throw new Error('Unable to create period fixture');
  }

  const timeSlots = await queryTenant<{ id: string }>(
    `
      INSERT INTO ${tenantTable('time_slots')} (label, start_time, end_time, sort_order)
      VALUES ($1, '08:00:00'::time, '09:00:00'::time, 100)
      RETURNING id
    `,
    [`fixture-slot-${suffix}`]
  );
  const timeSlotId = timeSlots[0]?.id;
  if (!timeSlotId) {
    throw new Error('Unable to create time slot fixture');
  }

  const schedules = await queryTenant<{ id: string }>(
    `
      INSERT INTO ${tenantTable('schedules')} (
        schedule_period_id,
        teacher_id,
        class_id,
        room_id,
        time_slot_id,
        day_of_week,
        subject,
        end_date,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, true)
      RETURNING id
    `,
    [
      schedulePeriodId,
      input.teacherId,
      input.classId,
      input.roomId,
      timeSlotId,
      input.dayOfWeek,
      input.subject,
      input.endDate ?? null,
    ]
  );

  const scheduleId = schedules[0]?.id;
  if (!scheduleId) {
    throw new Error('Unable to create schedule fixture');
  }

  return {
    scheduleId,
    schedulePeriodId,
    timeSlotId,
    dayOfWeek: input.dayOfWeek,
  };
};

describe('schedule history protection integration', () => {
  it("DELETE avec historique passé ferme le créneau (end_date) sans casser l'historique", async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const today = toIsoDate(new Date());

    const base = await queryTenant<{ class_id: string; room_id: string }>(
      `
        SELECT class_id, room_id
        FROM ${tenantTable('schedules')}
        WHERE id = $1
        LIMIT 1
      `,
      [context.scheduleId]
    );
    const classId = base[0]?.class_id;
    const roomId = base[0]?.room_id;
    expect(classId).toBeTruthy();
    expect(roomId).toBeTruthy();

    const fixture = await createScheduleFixture({
      teacherId: context.teacherId,
      classId: classId as string,
      roomId: roomId as string,
      dayOfWeek: 1,
      validFrom: addDays(today, -30),
      validTo: addDays(today, 30),
      subject: 'Histoire',
    });

    await queryTenant(
      `
        INSERT INTO ${tenantTable('attendances_teacher')} (teacher_id, schedule_id, date, status, room_mismatch, qr_alert_sent)
        VALUES
          ($1, $2, $3::date, 'present', false, false),
          ($1, $2, $4::date, 'present', false, false),
          ($1, $2, $5::date, 'absent', false, false)
      `,
      [context.teacherId, fixture.scheduleId, addDays(today, -1), addDays(today, -2), addDays(today, -3)]
    );

    const response = await request()
      .delete(`/api/v1/schedule/${fixture.scheduleId}`)
      .set(headers);
    expect(response.status).toBe(204);

    const scheduleRows = await queryTenant<{ end_date: string | null }>(
      `
        SELECT end_date::text AS end_date
        FROM ${tenantTable('schedules')}
        WHERE id = $1
      `,
      [fixture.scheduleId]
    );
    expect(scheduleRows[0]?.end_date).toBe(today);

    const attendanceRows = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('attendances_teacher')}
        WHERE schedule_id = $1
      `,
      [fixture.scheduleId]
    );
    expect(Number(attendanceRows[0]?.count ?? 0)).toBe(3);
  });

  it('PUT avec historique passé ferme la ligne actuelle et crée une nouvelle ligne', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const today = toIsoDate(new Date());

    const base = await queryTenant<{ class_id: string; room_id: string }>(
      `
        SELECT class_id, room_id
        FROM ${tenantTable('schedules')}
        WHERE id = $1
        LIMIT 1
      `,
      [context.scheduleId]
    );
    const classId = base[0]?.class_id;
    const roomId = base[0]?.room_id;
    expect(classId).toBeTruthy();
    expect(roomId).toBeTruthy();

    const fixture = await createScheduleFixture({
      teacherId: context.teacherId,
      classId: classId as string,
      roomId: roomId as string,
      dayOfWeek: 2,
      validFrom: addDays(today, -30),
      validTo: addDays(today, 30),
      subject: 'Mathématiques',
    });

    await queryTenant(
      `
        INSERT INTO ${tenantTable('attendances_teacher')} (teacher_id, schedule_id, date, status, room_mismatch, qr_alert_sent)
        VALUES ($1, $2, $3::date, 'present', false, false)
      `,
      [context.teacherId, fixture.scheduleId, addDays(today, -1)]
    );

    const response = await request()
      .put(`/api/v1/schedule/${fixture.scheduleId}`)
      .set(headers)
      .send({
        schedule_period_id: fixture.schedulePeriodId,
        teacher_id: context.teacherId,
        class_id: classId,
        room_id: roomId,
        time_slot_id: fixture.timeSlotId,
        day_of_week: fixture.dayOfWeek,
        subject: 'Physique',
        is_active: true,
      });

    expect(response.status).toBe(200);
    const newScheduleId = response.body?.schedule?.id as string | undefined;
    expect(newScheduleId).toBeTruthy();
    expect(newScheduleId).not.toBe(fixture.scheduleId);

    const oldRows = await queryTenant<{ end_date: string | null }>(
      `
        SELECT end_date::text AS end_date
        FROM ${tenantTable('schedules')}
        WHERE id = $1
      `,
      [fixture.scheduleId]
    );
    expect(oldRows[0]?.end_date).toBe(today);

    const newRows = await queryTenant<{ subject: string; end_date: string | null }>(
      `
        SELECT subject, end_date::text AS end_date
        FROM ${tenantTable('schedules')}
        WHERE id = $1
      `,
      [newScheduleId]
    );
    expect(newRows[0]?.subject).toBe('Physique');
    expect(newRows[0]?.end_date).toBeNull();

    const attendanceRows = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('attendances_teacher')}
        WHERE schedule_id = $1
      `,
      [fixture.scheduleId]
    );
    expect(Number(attendanceRows[0]?.count ?? 0)).toBe(1);
  });

  it('DELETE sans historique supprime normalement la ligne', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const today = toIsoDate(new Date());

    const base = await queryTenant<{ class_id: string; room_id: string }>(
      `
        SELECT class_id, room_id
        FROM ${tenantTable('schedules')}
        WHERE id = $1
        LIMIT 1
      `,
      [context.scheduleId]
    );
    const classId = base[0]?.class_id;
    const roomId = base[0]?.room_id;
    expect(classId).toBeTruthy();
    expect(roomId).toBeTruthy();

    const fixture = await createScheduleFixture({
      teacherId: context.teacherId,
      classId: classId as string,
      roomId: roomId as string,
      dayOfWeek: 3,
      validFrom: addDays(today, 1),
      validTo: addDays(today, 30),
      subject: 'SVT',
    });

    const response = await request()
      .delete(`/api/v1/schedule/${fixture.scheduleId}`)
      .set(headers);
    expect(response.status).toBe(204);

    const rows = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('schedules')}
        WHERE id = $1
      `,
      [fixture.scheduleId]
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
  });

  it('PUT sans historique modifie la ligne existante normalement', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const today = toIsoDate(new Date());

    const base = await queryTenant<{ class_id: string; room_id: string }>(
      `
        SELECT class_id, room_id
        FROM ${tenantTable('schedules')}
        WHERE id = $1
        LIMIT 1
      `,
      [context.scheduleId]
    );
    const classId = base[0]?.class_id;
    const roomId = base[0]?.room_id;
    expect(classId).toBeTruthy();
    expect(roomId).toBeTruthy();

    const fixture = await createScheduleFixture({
      teacherId: context.teacherId,
      classId: classId as string,
      roomId: roomId as string,
      dayOfWeek: 4,
      validFrom: addDays(today, 1),
      validTo: addDays(today, 30),
      subject: 'Anglais',
    });

    const response = await request()
      .put(`/api/v1/schedule/${fixture.scheduleId}`)
      .set(headers)
      .send({
        schedule_period_id: fixture.schedulePeriodId,
        teacher_id: context.teacherId,
        class_id: classId,
        room_id: roomId,
        time_slot_id: fixture.timeSlotId,
        day_of_week: fixture.dayOfWeek,
        subject: 'Espagnol',
        is_active: true,
      });

    expect(response.status).toBe(200);
    expect(response.body?.schedule?.id).toBe(fixture.scheduleId);

    const rows = await queryTenant<{ subject: string; end_date: string | null }>(
      `
        SELECT subject, end_date::text AS end_date
        FROM ${tenantTable('schedules')}
        WHERE id = $1
      `,
      [fixture.scheduleId]
    );
    expect(rows[0]?.subject).toBe('Espagnol');
    expect(rows[0]?.end_date).toBeNull();
  });

  it('DELETE avec effective_from futur clôture le créneau à cette date', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const today = toIsoDate(new Date());
    let effectiveFrom = addDays(today, 2);
    while (isoDayOfWeek(effectiveFrom) !== 5) {
      effectiveFrom = addDays(effectiveFrom, 1);
    }

    const base = await queryTenant<{ class_id: string; room_id: string }>(
      `
        SELECT class_id, room_id
        FROM ${tenantTable('schedules')}
        WHERE id = $1
        LIMIT 1
      `,
      [context.scheduleId]
    );
    const classId = base[0]?.class_id;
    const roomId = base[0]?.room_id;
    expect(classId).toBeTruthy();
    expect(roomId).toBeTruthy();

    const fixture = await createScheduleFixture({
      teacherId: context.teacherId,
      classId: classId as string,
      roomId: roomId as string,
      dayOfWeek: 5,
      validFrom: addDays(today, -30),
      validTo: addDays(today, 30),
      subject: 'Informatique',
    });

    const response = await request()
      .delete(`/api/v1/schedule/${fixture.scheduleId}?effective_from=${effectiveFrom}`)
      .set(headers);
    expect(response.status).toBe(204);

    const scheduleRows = await queryTenant<{ end_date: string | null }>(
      `
        SELECT end_date::text AS end_date
        FROM ${tenantTable('schedules')}
        WHERE id = $1
      `,
      [fixture.scheduleId]
    );
    expect(scheduleRows[0]?.end_date).toBe(effectiveFrom);

    const directorWeekly = await request()
      .get(`/api/v1/schedule/weekly?date=${mondayForIsoDate(effectiveFrom)}`)
      .set(headers);
    expect(directorWeekly.status).toBe(200);
    const directorSchedules = (directorWeekly.body?.schedules ?? []) as Array<{ id: string }>;
    expect(directorSchedules.some((row) => row.id === fixture.scheduleId)).toBe(false);

    const teacherHeaders = await getAuthHeaders('teacher');
    const teacherWeekly = await request()
      .get(`/api/v1/schedule/teacher/me/week?date=${mondayForIsoDate(effectiveFrom)}`)
      .set(teacherHeaders);
    expect(teacherWeekly.status).toBe(200);
    const teacherRows = (teacherWeekly.body ?? []) as Array<{ id: string }>;
    expect(teacherRows.some((row) => row.id === fixture.scheduleId)).toBe(false);
  });

  it('PUT avec effective_from futur versionne à partir de cette date', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const today = toIsoDate(new Date());
    let effectiveFrom = addDays(today, 2);
    while (isoDayOfWeek(effectiveFrom) !== 4) {
      effectiveFrom = addDays(effectiveFrom, 1);
    }

    const base = await queryTenant<{ class_id: string; room_id: string }>(
      `
        SELECT class_id, room_id
        FROM ${tenantTable('schedules')}
        WHERE id = $1
        LIMIT 1
      `,
      [context.scheduleId]
    );
    const classId = base[0]?.class_id;
    const roomId = base[0]?.room_id;
    expect(classId).toBeTruthy();
    expect(roomId).toBeTruthy();

    const fixture = await createScheduleFixture({
      teacherId: context.teacherId,
      classId: classId as string,
      roomId: roomId as string,
      dayOfWeek: 2,
      validFrom: addDays(today, -30),
      validTo: addDays(today, 30),
      subject: 'Sciences',
    });

    const response = await request()
      .put(`/api/v1/schedule/${fixture.scheduleId}`)
      .set(headers)
      .send({
        schedule_period_id: fixture.schedulePeriodId,
        teacher_id: context.teacherId,
        class_id: classId,
        room_id: roomId,
        time_slot_id: fixture.timeSlotId,
        day_of_week: fixture.dayOfWeek,
        subject: 'Sciences physiques',
        effective_from: effectiveFrom,
        is_active: true,
      });

    expect(response.status).toBe(200);
    const newScheduleId = response.body?.schedule?.id as string | undefined;
    expect(newScheduleId).toBeTruthy();
    expect(newScheduleId).not.toBe(fixture.scheduleId);
    expect(response.body?.change_effective_from).toBe(effectiveFrom);

    const oldRows = await queryTenant<{ end_date: string | null }>(
      `
        SELECT end_date::text AS end_date
        FROM ${tenantTable('schedules')}
        WHERE id = $1
      `,
      [fixture.scheduleId]
    );
    expect(oldRows[0]?.end_date).toBe(effectiveFrom);

    const newRows = await queryTenant<{ subject: string; start_date: string | null; end_date: string | null }>(
      `
        SELECT subject, start_date::text AS start_date, end_date::text AS end_date
        FROM ${tenantTable('schedules')}
        WHERE id = $1
      `,
      [newScheduleId]
    );
    expect(newRows[0]?.subject).toBe('Sciences Physiques');
    expect(newRows[0]?.start_date).toBe(effectiveFrom);
    expect(newRows[0]?.end_date).toBeNull();
  });

  it('PUT/DELETE avec effective_from passé retourne 409 SCHEDULE_PAST_LOCKED', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const today = toIsoDate(new Date());
    const yesterday = addDays(today, -1);

    const base = await queryTenant<{ class_id: string; room_id: string; schedule_period_id: string; day_of_week: number; time_slot_id: string }>(
      `
        SELECT class_id, room_id, schedule_period_id, day_of_week, time_slot_id
        FROM ${tenantTable('schedules')}
        WHERE id = $1
        LIMIT 1
      `,
      [context.scheduleId]
    );

    const putResponse = await request()
      .put(`/api/v1/schedule/${context.scheduleId}`)
      .set(headers)
      .send({
        schedule_period_id: base[0]?.schedule_period_id,
        teacher_id: context.teacherId,
        class_id: base[0]?.class_id,
        room_id: base[0]?.room_id,
        time_slot_id: base[0]?.time_slot_id,
        day_of_week: base[0]?.day_of_week,
        subject: 'Test verrou passé',
        effective_from: yesterday,
        is_active: true,
      });

    expect(putResponse.status).toBe(409);
    expect(putResponse.body?.code).toBe('SCHEDULE_PAST_LOCKED');

    const deleteResponse = await request()
      .delete(`/api/v1/schedule/${context.scheduleId}?effective_from=${yesterday}`)
      .set(headers);

    expect(deleteResponse.status).toBe(409);
    expect(deleteResponse.body?.code).toBe('SCHEDULE_PAST_LOCKED');
  });

  it('GET salary details inclut les créneaux dont end_date est dans le passé du mois', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const today = toIsoDate(new Date());
    const month = today.slice(0, 7);
    const { start: monthStart, end: monthEnd } = monthBounds(month);

    const upperBound = addDays(today, -2);
    const targetDate = findFirstWeekdayInRange(monthStart, upperBound);
    expect(targetDate).toBeTruthy();

    const base = await queryTenant<{ class_id: string; room_id: string }>(
      `
        SELECT class_id, room_id
        FROM ${tenantTable('schedules')}
        WHERE id = $1
        LIMIT 1
      `,
      [context.scheduleId]
    );
    const classId = base[0]?.class_id;
    const roomId = base[0]?.room_id;
    expect(classId).toBeTruthy();
    expect(roomId).toBeTruthy();

    const dayOfWeek = isoDayOfWeek(targetDate as string);
    const fixture = await createScheduleFixture({
      teacherId: context.teacherId,
      classId: classId as string,
      roomId: roomId as string,
      dayOfWeek,
      validFrom: monthStart,
      validTo: monthEnd,
      subject: 'Chimie',
      endDate: addDays(targetDate as string, 1),
    });

    await queryTenant(
      `
        INSERT INTO ${tenantTable('attendances_teacher')} (teacher_id, schedule_id, date, status, room_mismatch, qr_alert_sent)
        VALUES ($1, $2, $3::date, 'present', false, false)
      `,
      [context.teacherId, fixture.scheduleId, targetDate]
    );

    const response = await request()
      .get(`/api/v1/billing/salary/${context.teacherId}?month=${month}`)
      .set(headers);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body?.rows)).toBe(true);
    expect(
      (response.body?.rows as Array<{ scheduleId: string }>).some(
        (row) => row.scheduleId === fixture.scheduleId
      )
    ).toBe(true);
  });
});
