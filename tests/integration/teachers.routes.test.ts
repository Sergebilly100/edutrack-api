import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable } from './setup.js';

// Insère un prof directement en DB (contourne la vérification de plan qui nécessite public.tenants)
const seedTeacher = async (overrides: Record<string, unknown> = {}): Promise<{ teacherId: string; userId: string }> => {
  const passwordHash = await argon2.hash('test1234');
  const suffix = Math.random().toString(36).slice(2, 8);

  const users = await queryTenant<{ id: string }>(
    `INSERT INTO ${tenantTable('users')} (role, name, phone, email, password_hash, is_active)
     VALUES ('teacher', $1, NULL, $3, $2, true) RETURNING id`,
    [
      `${(overrides.last_name as string) ?? 'Test'} ${suffix}`,
      passwordHash,
      typeof overrides.email === 'string' ? overrides.email : null,
    ]
  );
  const userId = users[0]?.id;
  if (!userId) throw new Error('Failed to seed user');

  const type = (overrides.type as string) ?? 'vacataire';
  const hourlyRate = type === 'permanent' ? null : ((overrides.hourly_rate as number) ?? 4500);
  const monthlySalary = type === 'permanent' ? ((overrides.monthly_salary as number) ?? 350000) : null;

  const teachers = await queryTenant<{ id: string }>(
    `INSERT INTO ${tenantTable('teachers')} (user_id, username, type, subjects, hourly_rate, monthly_salary)
     VALUES ($1, $2, $3, $4::text[], $5, $6) RETURNING id`,
    [userId, `test.${suffix}`, type, ['SVT'], hourlyRate, monthlySalary]
  );
  const teacherId = teachers[0]?.id;
  if (!teacherId) throw new Error('Failed to seed teacher');

  return { teacherId, userId };
};

const grantStaffPermissions = async (permissions: string[]): Promise<void> => {
  const context = getSeedContext();
  const positionName = `Teacher perms ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
  const positions = await queryTenant<{ id: string }>(
    `
      INSERT INTO ${tenantTable('admin_positions')} (name, permissions, created_by)
      VALUES ($1, $2::jsonb, $3)
      RETURNING id
    `,
    [positionName, JSON.stringify(permissions), context.directorUserId]
  );
  const positionId = positions[0]?.id;
  expect(positionId).toBeTruthy();

  await queryTenant(
    `
      INSERT INTO ${tenantTable('position_assignments')} (user_id, position_id, assigned_by)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `,
    [context.staffUserId, positionId, context.directorUserId]
  );
};

describe('teachers integration (real db)', () => {
  // ── GET /teachers ─────────────────────────────────────────────────────────

  describe('GET /api/v1/teachers', () => {
    it('retourne 200 avec une liste paginée', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get('/api/v1/teachers?page=1&limit=10')
        .set(headers);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.pagination).toMatchObject({
        page: 1,
        limit: 10,
      });
    });

    it('filtre par type vacataire', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get('/api/v1/teachers?page=1&limit=100&type=vacataire')
        .set(headers);

      expect(response.status).toBe(200);
      const allVacataire = (response.body.data as Array<{ type: string }>).every(
        (t) => t.type === 'vacataire'
      );
      expect(allVacataire).toBe(true);
    });

    it('retourne 403 pour un prof (non autorisé)', async () => {
      const headers = await getAuthHeaders('teacher');

      const response = await request()
        .get('/api/v1/teachers')
        .set(headers);

      expect(response.status).toBe(403);
    });
  });

  // ── GET /teachers/:id ─────────────────────────────────────────────────────

  describe('GET /api/v1/teachers/:id', () => {
    it('retourne le prof par id', async () => {
      const headers = await getAuthHeaders('director');
      const { teacherId } = await seedTeacher({ last_name: 'ById' });

      const response = await request()
        .get(`/api/v1/teachers/${teacherId}`)
        .set(headers);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(teacherId);
      expect(response.body.type).toBe('vacataire');
    });

    it('retourne 404 si prof introuvable', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get('/api/v1/teachers/00000000-0000-0000-0000-000000000000')
        .set(headers);

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('TEACHER_NOT_FOUND');
    });
  });

  // ── PUT /teachers/:id (update) ────────────────────────────────────────────

  describe('PUT /api/v1/teachers/:id', () => {
    it('met a jour le taux horaire', async () => {
      const headers = await getAuthHeaders('director');
      const { teacherId } = await seedTeacher({ last_name: 'Update', email: 'update.test@test.local' });

      const response = await request()
        .put(`/api/v1/teachers/${teacherId}`)
        .set(headers)
        .send({ hourly_rate: 6000 });

      expect(response.status).toBe(200);
      expect(response.body.hourly_rate).toBe(6000);
    });

    it('bloque le changement de type si salary pending existe', async () => {
      const headers = await getAuthHeaders('director');
      const { teacherId } = await seedTeacher({ last_name: 'TypeChange', email: 'typechange.test@test.local' });

      // Insérer un salary_record pending
      await queryTenant(
        `INSERT INTO ${tenantTable('salary_records')}
         (teacher_id, period_month, hours_planned, hours_done, hourly_rate, total_fcfa, status)
         VALUES ($1, '2026-03-01', 20, 10, 4500, 45000, 'pending')`,
        [teacherId]
      );

      const response = await request()
        .put(`/api/v1/teachers/${teacherId}`)
        .set(headers)
        .send({ type: 'permanent', monthly_salary: 350000 });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('TEACHER_TYPE_CHANGE_BLOCKED');
    });

    it('autorise le changement de type si tous les salaires sont payes', async () => {
      const headers = await getAuthHeaders('director');
      const { teacherId } = await seedTeacher({ last_name: 'TypeOk', email: 'typeok.test@test.local' });

      // Insérer un salary_record paid
      await queryTenant(
        `INSERT INTO ${tenantTable('salary_records')}
         (teacher_id, period_month, hours_planned, hours_done, hourly_rate, total_fcfa, status)
         VALUES ($1, '2026-02-01', 10, 10, 4500, 45000, 'paid')`,
        [teacherId]
      );

      const response = await request()
        .put(`/api/v1/teachers/${teacherId}`)
        .set(headers)
        .send({ type: 'permanent', monthly_salary: 350000 });

      expect(response.status).toBe(200);
      expect(response.body.type).toBe('permanent');
    });

    it('retourne 404 si prof introuvable', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .put('/api/v1/teachers/00000000-0000-0000-0000-000000000000')
        .set(headers)
        .send({ hourly_rate: 5000 });

      expect(response.status).toBe(404);
    });
  });

  // ── DELETE /teachers/:id (soft delete) ───────────────────────────────────

  describe('DELETE /api/v1/teachers/:id (soft delete)', () => {
    it('desactive le prof (is_active = false)', async () => {
      const headers = await getAuthHeaders('director');
      const { teacherId } = await seedTeacher({ last_name: 'Delete' });

      const response = await request()
        .delete(`/api/v1/teachers/${teacherId}`)
        .set(headers);

      expect(response.status).toBe(200);
      expect(response.body.is_active).toBe(false);
    });

    it('retourne 404 si prof introuvable', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .delete('/api/v1/teachers/00000000-0000-0000-0000-000000000000')
        .set(headers);

      expect(response.status).toBe(404);
    });
  });

  // ── GET /teachers/:id/stats ───────────────────────────────────────────────

  describe('GET /api/v1/teachers/:id/stats', () => {
    it('retourne les stats avec des valeurs numériques', async () => {
      const headers = await getAuthHeaders('director');
      const { teacherId } = await seedTeacher({ last_name: 'Stats' });

      const currentMonth = new Date().toISOString().slice(0, 7);
      const dateFrom = `${currentMonth}-01`;
      const dateTo = `${currentMonth}-28`;

      const response = await request()
        .get(`/api/v1/teachers/${teacherId}/stats?date_from=${dateFrom}&date_to=${dateTo}`)
        .set(headers);

      expect(response.status).toBe(200);
      expect(typeof response.body.attendance_rate).toBe('number');
      expect(typeof response.body.hours_worked).toBe('number');
      expect(typeof response.body.amount_due).toBe('number');
    });
  });

  describe('GET /api/v1/teachers/attendance-stats', () => {
    it('compte les heures non validees par la direction comme absence partielle', async () => {
      const headers = await getAuthHeaders('director');
      const context = getSeedContext();
      const date = new Date();
      do {
        date.setUTCDate(date.getUTCDate() - 1);
      } while (date.getUTCDay() === 0);
      const dateIso = date.toISOString().slice(0, 10);
      const dayOfWeek = date.getUTCDay();
      const subject = `Absence partielle ${Date.now()}`;

      await queryTenant(`
        CREATE TABLE IF NOT EXISTS ${tenantTable('schedule_exceptions')} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          schedule_id uuid NOT NULL REFERENCES ${tenantTable('schedules')}(id) ON DELETE CASCADE,
          exception_date date NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const sourceSchedule = await queryTenant<{
        schedule_period_id: string;
        class_id: string;
        room_id: string;
      }>(
        `
          SELECT schedule_period_id, class_id, room_id
          FROM ${tenantTable('schedules')}
          WHERE id = $1
          LIMIT 1
        `,
        [context.scheduleId]
      );
      expect(sourceSchedule[0]).toBeTruthy();

      const timeSlots = await queryTenant<{ id: string }>(
        `
          INSERT INTO ${tenantTable('time_slots')} (label, start_time, end_time, sort_order)
          VALUES ($1, '08:00'::time, '10:00'::time, 998)
          RETURNING id
        `,
        [`partial-absence-${Date.now()}`]
      );
      const timeSlotId = timeSlots[0]?.id;
      expect(timeSlotId).toBeTruthy();

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
            is_active
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, true)
          RETURNING id
        `,
        [
          sourceSchedule[0]!.schedule_period_id,
          context.teacherId,
          sourceSchedule[0]!.class_id,
          sourceSchedule[0]!.room_id,
          timeSlotId,
          dayOfWeek,
          subject,
        ]
      );
      const scheduleId = schedules[0]?.id;
      expect(scheduleId).toBeTruthy();

      await queryTenant(
        `
          INSERT INTO ${tenantTable('attendances_teacher')} (
            teacher_id,
            schedule_id,
            date,
            status,
            validation_status,
            validated_hours,
            room_mismatch,
            qr_alert_sent
          )
          VALUES ($1, $2, $3::date, 'present', 'approved', 1.5, false, false)
        `,
        [context.teacherId, scheduleId, dateIso]
      );

      const response = await request()
        .get(
          `/api/v1/teachers/attendance-stats?from=${dateIso}&to=${dateIso}&teacher_id=${context.teacherId}&subject=${encodeURIComponent(subject)}`
        )
        .set(headers);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        total_scheduled: 1,
        present_count: 1,
        absent_count: 1,
        hours_scheduled: 2,
        hours_done: 1.5,
      });

      const absentFilter = await request()
        .get(
          `/api/v1/teachers/attendance-stats?from=${dateIso}&to=${dateIso}&teacher_id=${context.teacherId}&subject=${encodeURIComponent(subject)}&status_filter=absent`
        )
        .set(headers);

      expect(absentFilter.status).toBe(200);
      expect(absentFilter.body).toHaveLength(1);
      expect(absentFilter.body[0].hours_done).toBe(1.5);
    });

    it('ne projette pas les cours apres la date de fin de periode active', async () => {
      const headers = await getAuthHeaders('director');
      const context = getSeedContext();
      const subject = `Periode bornee ${Date.now()}`;
      const firstDate = '2030-01-07';
      const secondDate = '2030-01-14';
      const dayOfWeek = 1;

      await queryTenant(`
        CREATE TABLE IF NOT EXISTS ${tenantTable('schedule_exceptions')} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          schedule_id uuid NOT NULL REFERENCES ${tenantTable('schedules')}(id) ON DELETE CASCADE,
          exception_date date NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const sourceSchedule = await queryTenant<{
        class_id: string;
        room_id: string;
      }>(
        `
          SELECT class_id, room_id
          FROM ${tenantTable('schedules')}
          WHERE id = $1
          LIMIT 1
        `,
        [context.scheduleId]
      );
      expect(sourceSchedule[0]).toBeTruthy();

      const periods = await queryTenant<{ id: string }>(
        `
          INSERT INTO ${tenantTable('schedule_periods')} (name, valid_from, valid_to, is_active, created_by)
          VALUES ($1, $2::date, $2::date, true, $3)
          RETURNING id
        `,
        [`period-bound-${Date.now()}`, firstDate, context.directorUserId]
      );
      const periodId = periods[0]?.id;
      expect(periodId).toBeTruthy();

      const timeSlots = await queryTenant<{ id: string }>(
        `
          INSERT INTO ${tenantTable('time_slots')} (label, start_time, end_time, sort_order)
          VALUES ($1, '08:00'::time, '09:00'::time, 997)
          RETURNING id
        `,
        [`period-bound-${Date.now()}`]
      );
      const timeSlotId = timeSlots[0]?.id;
      expect(timeSlotId).toBeTruthy();

      await queryTenant(
        `
          INSERT INTO ${tenantTable('schedules')} (
            schedule_period_id,
            teacher_id,
            class_id,
            room_id,
            time_slot_id,
            day_of_week,
            subject,
            is_active
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        `,
        [
          periodId,
          context.teacherId,
          sourceSchedule[0]!.class_id,
          sourceSchedule[0]!.room_id,
          timeSlotId,
          dayOfWeek,
          subject,
        ]
      );

      const response = await request()
        .get(
          `/api/v1/teachers/attendance-stats?from=${firstDate}&to=${secondDate}&teacher_id=${context.teacherId}&subject=${encodeURIComponent(subject)}`
        )
        .set(headers);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        total_scheduled: 1,
        hours_scheduled: 1,
      });
    });
  });

  describe('permissions staff spécialisées', () => {
    it('autorise l analyse de présence prof avec teachers.attendance.view', async () => {
      await grantStaffPermissions(['teachers.attendance.view']);
      const headers = await getAuthHeaders('staff');
      const currentMonth = new Date().toISOString().slice(0, 7);

      const response = await request()
        .get(`/api/v1/teachers/attendance-stats?from=${currentMonth}-01&to=${currentMonth}-28`)
        .set(headers);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('refuse la réinitialisation mdp prof avec teachers.view seul', async () => {
      await grantStaffPermissions(['teachers.view']);
      const headers = await getAuthHeaders('staff');
      const { teacherId } = await seedTeacher({ last_name: 'ResetForbidden' });

      const response = await request()
        .post(`/api/v1/teachers/${teacherId}/reset-password`)
        .set(headers)
        .send({});

      expect(response.status).toBe(403);
    });

    it('autorise la réinitialisation mdp prof avec teachers.password.reset sans teachers.edit', async () => {
      await grantStaffPermissions(['teachers.view', 'teachers.password.reset']);
      const headers = await getAuthHeaders('staff');
      const { teacherId } = await seedTeacher({ last_name: 'ResetByStaff' });

      const response = await request()
        .post(`/api/v1/teachers/${teacherId}/reset-password`)
        .set(headers)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.emailSent).toBe(false);
      expect(typeof response.body.plainPassword).toBe('string');
    });
  });
});
