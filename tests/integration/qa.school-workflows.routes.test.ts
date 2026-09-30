import { beforeAll, describe, expect, it, vi } from 'vitest';

import { eventBus } from '../../src/shared/events/event-bus.js';
import { getAuthHeaders, getSeedContext, queryPublic, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

describe('F01–F07/F30/F34/F35 — parcours école avec persistance', () => {
  beforeAll(async () => {
    await queryPublic(`INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
      VALUES ('École QA', $1, $2, 'pro', 'active', 50, false)`, [TEST_SCHEMA_NAME.replaceAll('_', '-'), TEST_SCHEMA_NAME]);
  });

  it('F07 : crée, géolocalise, régénère le QR et archive une salle ; refuse une salle utilisée', async () => {
    const headers = await getAuthHeaders('director');
    const created = await request().post('/api/v1/rooms').set(headers).send({ name: 'Salle QA', capacity: 30 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const roomId = created.body.room.id as string;
    const firstQr = await request().get(`/api/v1/rooms/${roomId}/qr`).set(headers);
    expect(firstQr.status).toBe(200);
    expect(firstQr.body.qr_token).toMatch(/^[a-f0-9]{64}$/);
    const updated = await request().patch(`/api/v1/rooms/${roomId}`).set(headers)
      .send({ name: 'Salle QA GPS', latitude: 5.35, longitude: -4.02, geoRadius: 80 });
    expect(updated.status).toBe(200);
    const regenerated = await request().post(`/api/v1/rooms/${roomId}/regenerate-token`).set(headers);
    expect(regenerated.status).toBe(200);
    const secondQr = await request().get(`/api/v1/rooms/${roomId}/qr`).set(headers);
    expect(secondQr.body.qr_token).not.toBe(firstQr.body.qr_token);
    expect(secondQr.body).toMatchObject({ room_name: 'Salle QA GPS', qr_token: regenerated.body.room.qrToken });
    const list = await request().get('/api/v1/rooms').set(headers);
    expect(list.body.rooms).toEqual(expect.arrayContaining([expect.objectContaining({ id: roomId, latitude: 5.35, longitude: -4.02, geoRadius: 80 })]));
    expect((await request().delete(`/api/v1/rooms/${roomId}`).set(headers)).status).toBe(200);
    const after = await request().get('/api/v1/rooms').set(headers);
    expect(after.body.rooms).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: roomId })]));
    const [schedule] = await queryTenant<{ room_id: string }>(`SELECT room_id FROM ${tenantTable('schedules')} WHERE id=$1`, [getSeedContext().scheduleId]);
    const blocked = await request().delete(`/api/v1/rooms/${schedule!.room_id}`).set(headers);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ROOM_HAS_SCHEDULES');
  });

  it('F01/F02/F03/F30 : pointage, QR, appel, correction, alerte et justification du même élève', async () => {
    const context = getSeedContext();
    const director = await getAuthHeaders('director');
    const teacher = await getAuthHeaders('teacher');
    const staff = await getAuthHeaders('staff');
    const today = new Date().toISOString().slice(0, 10);
    const [schedule] = await queryTenant<{ class_id: string }>(`SELECT class_id FROM ${tenantTable('schedules')} WHERE id=$1`, [context.scheduleId]);
    const student = await request().post('/api/v1/students').set(director).send({ class_id: schedule!.class_id, first_name: 'Aya', last_name: 'Appel', parent_phone: '2250700001111' });
    expect(student.status).toBe(201);
    const studentId = student.body.data.id as string;
    const yearId = (await queryTenant<{ id: string }>(`INSERT INTO ${tenantTable('school_years')}
      (label,start_date,end_date,status) VALUES ('QA appel','2026-09-01','2027-06-30','active') RETURNING id`))[0]!.id;
    await queryTenant(`UPDATE ${tenantTable('classes')} SET school_year_id=$1::uuid WHERE id=$2::uuid`, [yearId, schedule!.class_id]);
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id,class_id,school_year_id,type,status)
      VALUES ($1::uuid,$2::uuid,$3::uuid,'new_registration','confirmed')`, [studentId, schedule!.class_id, yearId]);
    expect((await request().post('/api/v1/attendance/check-in').set(teacher).send({ schedule_id: context.scheduleId, date: today })).status).toBe(200);
    const qr = await request().post('/api/v1/attendance/qr-scan').set(teacher)
      .send({ schedule_id: context.scheduleId, qr_token: context.validRoomToken, scan_type: 'start', date: today });
    expect(qr.status).toBe(200);
    expect(qr.body.data).toMatchObject({ valid: true, roomMismatch: false });
    const absent = vi.fn();
    eventBus.on('student.absent', absent);
    try {
      const mark = (ids: string[]) => request().post('/api/v1/attendance/students/bulk').set(teacher)
        .send({ schedule_id: context.scheduleId, date: today, absent_student_ids: ids });
      const first = await mark([studentId]);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const pendingId = (await queryTenant<{ id: string }>(`INSERT INTO ${tenantTable('students')}
        (class_id,first_name,last_name,is_active) VALUES ($1::uuid,'Dossier','En attente',true) RETURNING id`, [schedule!.class_id]))[0]!.id;
      await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id,class_id,school_year_id,type,status)
        VALUES ($1::uuid,$2::uuid,$3::uuid,'new_registration','pending_cashier')`, [pendingId, schedule!.class_id, yearId]);
      const refusedAbsence = await mark([pendingId]);
      expect(refusedAbsence.status).toBe(400);
      expect(refusedAbsence.body.code).toBe('STUDENT_CLASS_MISMATCH');
      expect(absent).toHaveBeenCalledWith(expect.objectContaining({ studentId, scheduleId: context.scheduleId, date: today }));
      const initial = await request().get(`/api/v1/attendance/students/roll-call?schedule_id=${context.scheduleId}&date=${today}`).set(teacher);
      expect(initial.status).toBe(200);
      expect(initial.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ student_id: studentId, status: 'absent' })]));
      expect((await mark([])).status).toBe(200);
      const corrected = await queryTenant<{ status: string }>(`SELECT status FROM ${tenantTable('attendances_student')} WHERE student_id=$1 AND date=$2`, [studentId, today]);
      expect(corrected).toEqual([{ status: 'present' }]);
      expect((await mark([studentId])).status).toBe(200);
      const [attendance] = await queryTenant<{ id: string }>(`SELECT id FROM ${tenantTable('attendances_student')} WHERE student_id=$1 AND date=$2`, [studentId, today]);
      const excusePath = `/api/v1/students/absences/${attendance!.id}/excuse`;
      expect((await request().patch(excusePath).set(staff).send({ reason: 'Certificat médical' })).status).toBe(403);
      const justified = await request().patch(excusePath).set(director).send({ reason: 'Certificat médical' });
      expect(justified.status).toBe(200);
      expect(justified.body.data).toMatchObject({ status: 'excused', excuseReason: 'Certificat médical' });
      const history = await request().get(`/api/v1/students/${studentId}/absences?from=${today}&to=${today}`).set(director);
      expect(history.status).toBe(200);
      expect(history.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: attendance!.id, status: 'excused', excuseReason: 'Certificat médical' })]));
      expect((await request().patch(excusePath).set(director).send({ reason: 'Deuxième justification' })).status).toBe(409);
    } finally {
      eventBus.off('student.absent', absent);
      await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE id=$1::uuid`, [yearId]);
    }
  });

  it('F34 : crée un compte et un poste puis accorde et révoque un accès réel', async () => {
    const director = await getAuthHeaders('director');
    const created = await request().post('/api/v1/permissions/users').set(director)
      .send({ name: 'Agent QA', email: 'agent.qa@example.test', password: 'AgentQa!2026' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const userId = created.body.user.id as string;
    const login = await request().post('/api/v1/auth/login/teacher').set('x-tenant-schema', TEST_SCHEMA_NAME)
      .send({ identifier: 'agent.qa@example.test', password: 'AgentQa!2026' });
    expect(login.status).toBe(200);
    const agent = { authorization: `Bearer ${login.body.accessToken}`, 'x-tenant-schema': TEST_SCHEMA_NAME };
    expect((await request().get('/api/v1/rooms').set(agent)).status).toBe(403);
    const position = await request().post('/api/v1/permissions/positions').set(director)
      .send({ name: 'Consultation salles QA', permissions: ['rooms.view'] });
    expect(position.status).toBe(201);
    const positionId = position.body.position.id as string;
    expect((await request().post(`/api/v1/permissions/positions/${positionId}/assign`).set(director).send({ userId })).status).toBe(200);
    const permissions = await request().get('/api/v1/permissions/me').set(agent);
    expect(permissions.body.permissions).toContain('rooms.view');
    expect((await request().get('/api/v1/rooms').set(agent)).status).toBe(200);
    expect((await request().post('/api/v1/rooms').set(agent).send({ name: 'Interdite' })).status).toBe(403);
    expect((await request().delete(`/api/v1/permissions/positions/${positionId}/assign/${userId}`).set(director)).status).toBe(200);
    expect((await request().get('/api/v1/rooms').set(agent)).status).toBe(403);
    expect((await request().delete(`/api/v1/permissions/positions/${positionId}`).set(director)).status).toBe(200);
    expect((await request().delete(`/api/v1/permissions/users/${userId}`).set(director)).status).toBe(200);
    const relogin = await request().post('/api/v1/auth/login/teacher').set('x-tenant-schema', TEST_SCHEMA_NAME)
      .send({ identifier: 'agent.qa@example.test', password: 'AgentQa!2026' });
    expect(relogin.status).toBe(401);
  });

  it('F06 : duplique une période et ses affectations sans modifier les créneaux sources', async () => {
    const headers = await getAuthHeaders('director');
    const [source] = await queryTenant<{ schedule_period_id: string; teacher_id: string; class_id: string; room_id: string; time_slot_id: string }>(
      'SELECT schedule_period_id, teacher_id, class_id, room_id, time_slot_id FROM schedules WHERE id=$1', [getSeedContext().scheduleId]);
    // C10: duplication requires an exact assignment in the active school year.
    const [initialClass] = await queryTenant<{ level_id: string | null; school_year_id: string | null }>('SELECT level_id, school_year_id FROM classes WHERE id=$1', [source!.class_id]);
    const [year] = await queryTenant<{ id: string }>("INSERT INTO school_years (label,start_date,end_date,status) VALUES ('F06 QA','2094-09-01','2096-06-30','active') RETURNING id");
    const [level] = await queryTenant<{ id: string }>("INSERT INTO levels (name,order_index) VALUES ('F06 QA',1) RETURNING id");
    const [subject] = await queryTenant<{ id: string }>("INSERT INTO subjects (name,level_id,coefficient) SELECT subject, $1, 1 FROM schedules WHERE id=$2 RETURNING id", [level.id,getSeedContext().scheduleId]);
    await queryTenant('UPDATE classes SET level_id=$1,school_year_id=$2 WHERE id=$3',[level.id,year.id,source!.class_id]);
    await queryTenant('INSERT INTO teacher_subject_assignments (teacher_id,subject_id,class_id) VALUES ($1,$2,$3)',[source!.teacher_id,subject.id,source!.class_id]);
    try {
      const result = await request().post(`/api/v1/schedule/periods/${source!.schedule_period_id}/duplicate`).set(headers)
        .send({ new_name: 'Période dupliquée QA', new_valid_from: '2095-01-03', new_valid_to: '2095-04-03' });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      expect(result.body.copied_schedules_count).toBe(1);
      const periodId = result.body.period.id as string;
      expect(periodId).not.toBe(source!.schedule_period_id);
      const copied = await queryTenant<{ teacher_id: string; class_id: string; room_id: string; time_slot_id: string }>(
        'SELECT teacher_id, class_id, room_id, time_slot_id FROM schedules WHERE schedule_period_id=$1', [periodId]);
      expect(copied).toEqual([{ teacher_id: source!.teacher_id, class_id: source!.class_id, room_id: source!.room_id, time_slot_id: source!.time_slot_id }]);
      const listed = await request().get('/api/v1/schedule/periods').set(headers);
      expect(listed.body.periods).toEqual(expect.arrayContaining([expect.objectContaining({ id: periodId, name: 'Période dupliquée QA' })]));
      const original = await queryTenant<{ count: number }>('SELECT COUNT(*)::int AS count FROM schedules WHERE schedule_period_id=$1', [source!.schedule_period_id]);
      expect(original[0]?.count).toBe(1);
    } finally {
      await queryTenant("UPDATE school_years SET status='closed' WHERE id=$1",[year.id]);
      await queryTenant('UPDATE classes SET level_id=$1,school_year_id=$2 WHERE id=$3',[initialClass.level_id,initialClass.school_year_id,source!.class_id]);
    }
  });

  it('F35 : sauvegarde les informations et la fin de configuration, interdit au professeur', async () => {
    const director = await getAuthHeaders('director');
    const teacher = await getAuthHeaders('teacher');
    const initial = await request().get('/api/v1/school/info').set(director);
    expect(initial.status).toBe(200);
    expect(initial.body.onboarding_completed).toBe(false);
    expect((await request().patch('/api/v1/school/onboarding-complete').set(teacher)).status).toBe(403);
    const saved = await request().patch('/api/v1/school/info').set(director).send({ name: 'École QA configurée', city: 'Abidjan', address: 'Abidjan, Cocody', phone: '2250700003333' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: 'École QA configurée', city: 'Abidjan', onboarding_completed: false });
    expect((await request().patch('/api/v1/school/onboarding-complete').set(director)).status).toBe(409);
    // F35 now requires actual academic and financial configuration.
    const [year] = await queryTenant<{ id: string }>(`INSERT INTO school_years (label, start_date, end_date, status)
      VALUES ('09/2098 - 06/2099', '2098-09-01', '2099-06-30', 'active') RETURNING id`);
    const [level] = await queryTenant<{ id: string }>(`INSERT INTO levels (name, order_index) VALUES ('F35', 1) RETURNING id`);
    await queryTenant(`INSERT INTO subjects (level_id, name, coefficient) VALUES ($1, 'Mathématiques F35', 1)`, [level!.id]);
    await queryTenant(`INSERT INTO tuition_plans (level_id, school_year_id, total_amount) VALUES ($1, $2, 100000)`, [level!.id, year!.id]);
    expect((await request().patch('/api/v1/school/onboarding-complete').set(director)).status).toBe(200);
    const reloaded = await request().get('/api/v1/school/info').set(director);
    expect(reloaded.body).toMatchObject({ name: 'École QA configurée', city: 'Abidjan', onboarding_completed: true });
  });
});
