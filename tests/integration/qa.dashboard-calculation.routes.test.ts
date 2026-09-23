import { beforeAll, describe, expect, it } from 'vitest';
import { getAuthHeaders, getSeedContext, queryTenant, request } from './setup.js';

describe('F08/F32 — calcul SQL réel des économies et heures payables', () => {
  beforeAll(async () => {
    const { scheduleId } = getSeedContext();
    await queryTenant(`UPDATE schedule_periods SET valid_from='2026-01-01', valid_to='2026-01-01'
      WHERE id=(SELECT schedule_period_id FROM schedules WHERE id=$1)`, [scheduleId]);
    await queryTenant(`UPDATE time_slots SET start_time='08:00', end_time='10:00'
      WHERE id=(SELECT time_slot_id FROM schedules WHERE id=$1)`, [scheduleId]);
    await queryTenant('UPDATE schedules SET day_of_week=4, start_date=NULL, end_date=NULL WHERE id=$1', [scheduleId]);
  });

  it.each([
    { status: 'present', validation: 'not_required', hours: null, paid: 10000, saved: 0, completed: 2 },
    { status: 'present', validation: 'approved', hours: 1.5, paid: 7500, saved: 2500, completed: 1.5 },
    { status: 'present', validation: 'rejected', hours: null, paid: 0, saved: 10000, completed: 0 },
    { status: 'absent', validation: 'not_required', hours: null, paid: 0, saved: 10000, completed: 0 },
  ])('$status / $validation : paie $paid, économie $saved', async ({ status, validation, hours, paid, saved, completed }) => {
    const seed = getSeedContext();
    await queryTenant(`INSERT INTO attendances_teacher (teacher_id, schedule_id, date, status, validation_status, validated_hours)
      VALUES ($1, $2, '2026-01-01', $3, $4, $5)`, [seed.teacherId, seed.scheduleId, status, validation, hours]);
    const result = await request().get('/api/v1/dashboard/stats?date=2026-01-01&month=2026-01').set(await getAuthHeaders('director'));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.salaries).toMatchObject({
      monthlyTotal: 10000,
      toPayCurrentPeriod: paid,
      economy: { plannedHours: 2, completedHours: completed, savedAmount: saved },
    });
  });
});
