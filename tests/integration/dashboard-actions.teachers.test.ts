import { describe, expect, it } from 'vitest';

import { runDashboardActionsForSchema } from '../../src/modules/dashboard-actions/dashboard-actions.worker.js';
import { buildRiskService } from '../../src/modules/risk/risk.service.js';
import { withTenantSchema } from '../../src/shared/database/db.js';
import {
  getAuthHeaders, getSeedContext, queryTenant, request, tenantTable, TEST_SCHEMA_NAME,
} from './setup.js';

describe('C13 — suivi enseignant et régénération du job dashboard', () => {
  it('applique la configuration au pointage, signale les retards seuls puis les deux motifs une seule fois', async () => {
    const headers = await getAuthHeaders('director');
    const teacherHeaders = await getAuthHeaders('teacher');
    const { teacherId, scheduleId } = getSeedContext();
    const route = '/api/v1/risk/rules/teacher/lateness';
    for (const body of [
      { thresholdValue: 2, periodDays: 30, isActive: true },
      { thresholdValue: 0, periodDays: 30, lateMinutes: 5, isActive: true },
      { thresholdValue: 2, periodDays: 21, lateMinutes: 5, isActive: true },
    ]) {
      expect((await request().put(route).set(headers).send(body)).status).toBe(400);
    }
    expect((await request().put(route).set(headers).send({ thresholdValue: 2, periodDays: 30, lateMinutes: 5, isActive: true })).status).toBe(200);
    const rules = await request().get('/api/v1/risk/rules').set(headers);
    expect(rules.body.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectType: 'teacher', signalType: 'lateness', thresholdValue: 2, periodDays: 30, lateMinutes: 5 }),
    ]));
    await queryTenant(
      `UPDATE ${tenantTable('time_slots')} SET start_time = '06:00', end_time = '23:59'
       WHERE id = (SELECT time_slot_id FROM ${tenantTable('schedules')} WHERE id = $1::uuid)`, [scheduleId]
    );
    const dateBefore = (days: number) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - days);
      return date.toISOString().slice(0, 10);
    };
    for (const days of [0, 1, 2]) {
      const date = dateBefore(days);
      const result = await request().post('/api/v1/attendance/check-in').set(teacherHeaders).send({
        schedule_id: scheduleId, date, client_timestamp: `${date}T06:0${days === 2 ? 5 : 6}:00.000Z`,
      });
      expect(result.status).toBe(200);
      expect(result.body.data.status).toBe(days === 2 ? 'present' : 'late');
    }
    // La fenêtre inclut J-29, exclut J-30 ainsi que les données futures.
    await queryTenant(
      `INSERT INTO ${tenantTable('attendances_teacher')} (teacher_id, schedule_id, date, status, late_minutes)
       SELECT $1::uuid, $2::uuid, CURRENT_DATE - offsets.day, 'late', 6
       FROM (VALUES (29), (30), (-1)) AS offsets(day)`, [teacherId, scheduleId]
    );
    const recalculate = () => withTenantSchema(TEST_SCHEMA_NAME, (db) => buildRiskService(db).recalculateTeachers());
    const readRisk = async () => {
      const response = await request().get('/api/v1/risk/teachers').set(headers).query({ atRisk: true });
      expect(response.status).toBe(200);
      return response.body.teachers.find((row: { teacher_id: string }) => row.teacher_id === teacherId);
    };
    await recalculate();
    expect(await readRisk()).toMatchObject({ absences_signal: false, lateness_signal: true, lateness_count: 3, risk_score: 1, level: 'attention' });
    await runDashboardActionsForSchema({ schemaName: TEST_SCHEMA_NAME });
    const lateOnlyActions = await request().get('/api/v1/dashboard/action-items').set(headers);
    expect(lateOnlyActions.body.items.filter((item: { type: string }) => item.type === 'teacher_at_risk')).toHaveLength(1);
    const lateOnlyPilotage = await request().get('/api/v1/dashboard/pilotage').set(headers);
    expect(lateOnlyPilotage.body.risks).toMatchObject({ teacherAbsences: 0, teacherLateness: 1, teachersAtRisk: 1 });
    await queryTenant(
      `INSERT INTO ${tenantTable('attendances_teacher')} (teacher_id, schedule_id, date, status)
       SELECT $1::uuid, $2::uuid, CURRENT_DATE - offsets.day, 'absent'
       FROM (VALUES (3), (4), (5)) AS offsets(day)`, [teacherId, scheduleId]
    );
    await recalculate();
    expect(await readRisk()).toMatchObject({ absences_signal: true, lateness_signal: true, risk_score: 2, level: 'warning' });
    const bothPilotage = await request().get('/api/v1/dashboard/pilotage').set(headers);
    expect(bothPilotage.body.risks).toMatchObject({ teacherAbsences: 1, teacherLateness: 1, teachersAtRisk: 1 });
    await runDashboardActionsForSchema({ schemaName: TEST_SCHEMA_NAME });
    await runDashboardActionsForSchema({ schemaName: TEST_SCHEMA_NAME });
    const actions = await request().get('/api/v1/dashboard/action-items').set(headers);
    expect(actions.body.items.filter((item: { type: string }) => item.type === 'teacher_at_risk')).toEqual([
      expect.objectContaining({ message: '1 professeur(s) à suivre pour leur assiduité' }),
    ]);
    await request().put(route).set(headers).send({ thresholdValue: 2, periodDays: 30, lateMinutes: 5, isActive: false });
    await recalculate();
    expect(await readRisk()).toMatchObject({ absences_signal: true, lateness_signal: false, risk_score: 1 });
  });

  it('sépare les élèves, conserve une seule action enseignant et exclut les comptes bloqués/inactifs', async () => {
    const headers = await getAuthHeaders('director');
    const { teacherId, teacherUserId, scheduleId } = getSeedContext();
    const [student] = await queryTenant<{ id: string }>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       SELECT class_id, 'Test', 'C13', 'C13-STUDENT' FROM ${tenantTable('schedules')}
       WHERE id = $1::uuid RETURNING id::text`,
      [scheduleId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('student_risk_status')}
       (student_id, absences_signal, grades_signal, risk_score, level)
       VALUES ($1::uuid, true, true, 2, 'warning')`,
      [student!.id]
    );

    const runJob = () => runDashboardActionsForSchema({ schemaName: TEST_SCHEMA_NAME });
    const listActions = async () => {
      const response = await request().get('/api/v1/dashboard/action-items').set(headers);
      expect(response.status).toBe(200);
      return response.body.items as Array<{ type: string; message: string }>;
    };
    const recalculate = () => withTenantSchema(TEST_SCHEMA_NAME, (db) =>
      buildRiskService(db).recalculateTeachers()
    );
    const listTeachers = async () => {
      const response = await request().get('/api/v1/risk/teachers').set(headers).query({ atRisk: true });
      expect(response.status).toBe(200);
      return response.body.teachers as Array<{ teacher_id: string; absences_signal: boolean }>;
    };

    await recalculate();
    await runJob();
    let actions = await listActions();
    expect(actions.filter((action) => action.type === 'student_at_risk')).toHaveLength(1);
    expect(actions.filter((action) => action.type === 'teacher_at_risk')).toHaveLength(0);

    // Trois absences atteignent la règle existante ; l'absence ancienne est hors fenêtre.
    await queryTenant(
      `INSERT INTO ${tenantTable('attendances_teacher')} (teacher_id, schedule_id, date, status)
       SELECT $1::uuid, $2::uuid, CURRENT_DATE - offsets.day, 'absent'
       FROM (VALUES (0), (1), (2), (31)) AS offsets(day)`,
      [teacherId, scheduleId]
    );
    await recalculate();
    expect(await listTeachers()).toEqual([
      expect.objectContaining({ teacher_id: teacherId, absences_signal: true }),
    ]);

    await runJob();
    await runJob();
    actions = await listActions();
    expect(actions.filter((action) => action.type === 'student_at_risk')).toHaveLength(1);
    expect(actions.filter((action) => action.type === 'teacher_at_risk')).toEqual([
      expect.objectContaining({ message: '1 professeur(s) à suivre pour leur assiduité' }),
    ]);
    const [openCount] = await queryTenant<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${tenantTable('dashboard_action_items')}
       WHERE type = 'teacher_at_risk' AND resolved_at IS NULL`
    );
    expect(openCount!.count).toBe(1);

    try {
      await queryTenant(`UPDATE ${tenantTable('teachers')} SET is_blocked = true WHERE id = $1::uuid`, [teacherId]);
      expect(await recalculate()).toBe(0);
      expect(await listTeachers()).toHaveLength(0);
      await runJob();
      expect((await listActions()).filter((action) => action.type === 'teacher_at_risk')).toHaveLength(0);

      // Le statut de risque préexistant reste exclu quand le compte est désactivé.
      await queryTenant(`UPDATE ${tenantTable('teachers')} SET is_blocked = false WHERE id = $1::uuid`, [teacherId]);
      await queryTenant(`UPDATE ${tenantTable('users')} SET is_active = false WHERE id = $1::uuid`, [teacherUserId]);
      expect(await recalculate()).toBe(0);
      expect(await listTeachers()).toHaveLength(0);
      await runJob();
      expect((await listActions()).filter((action) => action.type === 'teacher_at_risk')).toHaveLength(0);
    } finally {
      await queryTenant(`UPDATE ${tenantTable('teachers')} SET is_blocked = false WHERE id = $1::uuid`, [teacherId]);
      await queryTenant(`UPDATE ${tenantTable('users')} SET is_active = true WHERE id = $1::uuid`, [teacherUserId]);
    }
  });
});
