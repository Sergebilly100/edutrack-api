import argon2 from 'argon2';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuthHeaders, queryTenant, request, tenantTable } from './setup.js';

// Insère un prof directement en DB (contourne la vérification de plan qui nécessite public.tenants)
const seedTeacher = async (overrides: Record<string, unknown> = {}): Promise<{ teacherId: string; userId: string }> => {
  const passwordHash = await argon2.hash('test1234');
  const suffix = Math.random().toString(36).slice(2, 8);

  const users = await queryTenant<{ id: string }>(
    `INSERT INTO ${tenantTable('users')} (role, name, phone, password_hash, is_active)
     VALUES ('teacher', $1, NULL, $2, true) RETURNING id`,
    [`${(overrides.last_name as string) ?? 'Test'} ${suffix}`, passwordHash]
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
      const { teacherId } = await seedTeacher({ last_name: 'Update' });

      const response = await request()
        .put(`/api/v1/teachers/${teacherId}`)
        .set(headers)
        .send({ hourly_rate: 6000 });

      expect(response.status).toBe(200);
      expect(response.body.hourly_rate).toBe(6000);
    });

    it('bloque le changement de type si salary pending existe', async () => {
      const headers = await getAuthHeaders('director');
      const { teacherId } = await seedTeacher({ last_name: 'TypeChange' });

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
      const { teacherId } = await seedTeacher({ last_name: 'TypeOk' });

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
});
