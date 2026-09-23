import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable } from './setup.js';

type IdRow = { id: string };
type ScheduleTargetRow = {
  schedule_period_id: string;
  class_id: string;
  room_id: string;
  time_slot_id: string;
};

describe('schedule blocked teacher integration', () => {
  it('refuse de créer un créneau pour un professeur bloqué', async () => {
    const context = getSeedContext();
    const directorHeaders = await getAuthHeaders('director');
    const suffix = Date.now().toString();

    const users = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('users')} (role, name, phone, password_hash, is_active)
       VALUES ('teacher', $1, $2, 'not-used', true)
       RETURNING id::text`,
      [`Professeur bloqué ${suffix}`, `225079${suffix.slice(-7).padStart(7, '0')}`]
    );
    const userId = users[0]?.id;
    expect(userId).toBeTruthy();

    const teachers = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('teachers')} (user_id, username, type, subjects, hourly_rate, is_blocked)
       VALUES ($1::uuid, $2, 'vacataire', ARRAY['Mathématiques']::text[], 4000, true)
       RETURNING id::text`,
      [userId, `blocked.${suffix}`]
    );
    const teacherId = teachers[0]?.id;
    expect(teacherId).toBeTruthy();

    const targets = await queryTenant<ScheduleTargetRow>(
      `SELECT schedule_period_id::text, class_id::text, room_id::text, time_slot_id::text
       FROM ${tenantTable('schedules')}
       WHERE id = $1::uuid`,
      [context.scheduleId]
    );
    const target = targets[0];
    expect(target).toBeTruthy();

    const response = await request()
      .post('/api/v1/schedule')
      .set(directorHeaders)
      .send({
        schedule_period_id: target?.schedule_period_id,
        teacher_id: teacherId,
        class_id: target?.class_id,
        room_id: target?.room_id,
        time_slot_id: target?.time_slot_id,
        day_of_week: 1,
        subject: 'Mathématiques',
      });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'TEACHER_BLOCKED',
      statusCode: 409,
    });
  });
});
