import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  request,
  tenantTable,
  TEST_SCHEMA_NAME,
} from './setup.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const pastDate = '2024-03-15';
const pastMonth = '2024-03';

const insertPendingAttendance = async (overrides: Record<string, unknown> = {}): Promise<string> => {
  const context = getSeedContext();
  const rows = await queryTenant<{ id: string }>(
    `
      INSERT INTO ${tenantTable('attendances_teacher')} (
        teacher_id, schedule_id, date, checked_in_at, actual_minutes, validation_status
      )
      VALUES ($1, $2, $3::date, NOW() - INTERVAL '2 hours', 30, 'pending')
      RETURNING id
    `,
    [context.teacherId, context.scheduleId, pastDate]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('[test] Failed to insert pending attendance');

  if (Object.keys(overrides).length > 0) {
    const sets = Object.entries(overrides)
      .map(([k], i) => `${k} = $${i + 2}`)
      .join(', ');
    await queryTenant(
      `UPDATE ${tenantTable('attendances_teacher')} SET ${sets} WHERE id = $1`,
      [id, ...Object.values(overrides)]
    );
  }
  return id;
};

const insertCheckedInAttendance = async (): Promise<string> => {
  const context = getSeedContext();
  const rows = await queryTenant<{ id: string }>(
    `
      INSERT INTO ${tenantTable('attendances_teacher')} (
        teacher_id, schedule_id, date, checked_in_at, validation_status
      )
      VALUES ($1, $2, $3::date, NOW() - INTERVAL '2 hours', 'not_required')
      RETURNING id
    `,
    [context.teacherId, context.scheduleId, pastDate]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('[test] Failed to insert checked-in attendance');
  return id;
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('validations routes integration (real db)', () => {

  // ── GET /api/v1/validations/pending ──────────────────────────────────────

  describe('GET /api/v1/validations/pending', () => {
    it('retourne 200 avec la structure gps_suspicious/short_hours', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get('/api/v1/validations/pending')
        .set(headers);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('gps_suspicious');
      expect(response.body).toHaveProperty('short_hours');
      expect(Array.isArray(response.body.gps_suspicious)).toBe(true);
      expect(Array.isArray(response.body.short_hours)).toBe(true);
    });

    it('retourne 403 sans permission', async () => {
      const headers = await getAuthHeaders('teacher');

      const response = await request()
        .get('/api/v1/validations/pending')
        .set(headers);

      expect(response.status).toBe(403);
    });
  });

  // ── GET /api/v1/validations/pending/count ────────────────────────────────

  describe('GET /api/v1/validations/pending/count', () => {
    it('retourne les compteurs sans charger tout le payload', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get('/api/v1/validations/pending/count')
        .set(headers);

      expect(response.status).toBe(200);
      expect(typeof response.body.gps_suspicious).toBe('number');
      expect(typeof response.body.short_hours).toBe('number');
      expect(typeof response.body.total).toBe('number');
      expect(response.body.total).toBe(
        response.body.gps_suspicious + response.body.short_hours
      );
    });
  });

  // ── PATCH /api/v1/validations/:id/approve ────────────────────────────────

  describe('PATCH /api/v1/validations/:id/approve', () => {
    it('approuve une présence en attente', async () => {
      const id = await insertPendingAttendance();
      const headers = await getAuthHeaders('director');

      const response = await request()
        .patch(`/api/v1/validations/${id}/approve`)
        .set(headers)
        .send({});

      expect(response.status).toBe(200);

      const rows = await queryTenant<{ validation_status: string }>(
        `SELECT validation_status FROM ${tenantTable('attendances_teacher')} WHERE id = $1`,
        [id]
      );
      expect(rows[0]?.validation_status).toBe('approved');
    });

    it('approuve avec des heures personnalisées', async () => {
      const id = await insertPendingAttendance();
      const headers = await getAuthHeaders('director');

      const response = await request()
        .patch(`/api/v1/validations/${id}/approve`)
        .set(headers)
        .send({ validated_hours: 0.5 });

      expect(response.status).toBe(200);

      const rows = await queryTenant<{ validated_hours: string }>(
        `SELECT validated_hours FROM ${tenantTable('attendances_teacher')} WHERE id = $1`,
        [id]
      );
      expect(Number(rows[0]?.validated_hours)).toBe(0.5);
    });

    it('retourne 404 pour un ID inexistant', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .patch(`/api/v1/validations/${randomUUID()}/approve`)
        .set(headers)
        .send({});

      expect(response.status).toBe(404);
    });

    it('retourne 400 pour un ID non-UUID', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .patch('/api/v1/validations/not-a-uuid/approve')
        .set(headers)
        .send({});

      expect(response.status).toBe(400);
    });
  });

  // ── PATCH /api/v1/validations/:id/reject ─────────────────────────────────

  describe('PATCH /api/v1/validations/:id/reject', () => {
    it('rejette une présence avec un motif', async () => {
      const id = await insertPendingAttendance();
      const headers = await getAuthHeaders('director');

      const response = await request()
        .patch(`/api/v1/validations/${id}/reject`)
        .set(headers)
        .send({ reason: 'Enseignant absent confirmé' });

      expect(response.status).toBe(200);

      const rows = await queryTenant<{ validation_status: string; validation_reason: string }>(
        `SELECT validation_status, validation_reason FROM ${tenantTable('attendances_teacher')} WHERE id = $1`,
        [id]
      );
      expect(rows[0]?.validation_status).toBe('rejected');
      expect(rows[0]?.validation_reason).toBe('Enseignant absent confirmé');
    });

    it('retourne 400 si le motif est trop court', async () => {
      const id = await insertPendingAttendance();
      const headers = await getAuthHeaders('director');

      const response = await request()
        .patch(`/api/v1/validations/${id}/reject`)
        .set(headers)
        .send({ reason: 'ab' });

      expect(response.status).toBe(400);
    });
  });

  // ── GET /api/v1/validations/missing-end-scans ────────────────────────────

  describe('GET /api/v1/validations/missing-end-scans', () => {
    it('retourne un tableau pour un mois valide', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get(`/api/v1/validations/missing-end-scans?month=${pastMonth}`)
        .set(headers);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('retourne 400 pour un format de mois invalide', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get('/api/v1/validations/missing-end-scans?month=not-a-month')
        .set(headers);

      expect(response.status).toBe(400);
    });

    it('retourne les compteurs par prof si des scans manquent', async () => {
      await insertCheckedInAttendance();
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get(`/api/v1/validations/missing-end-scans?month=${pastMonth}`)
        .set(headers);

      expect(response.status).toBe(200);
      if (response.body.length > 0) {
        const first = response.body[0];
        expect(typeof first.teacherId).toBe('string');
        expect(typeof first.missingEndScanCount).toBe('number');
        expect(typeof first.warningCount).toBe('number');
        expect(typeof first.sanctionCount).toBe('number');
        expect(Array.isArray(first.sessions)).toBe(true);
      }
    });
  });

  // ── POST /api/v1/validations/end-scan-action ─────────────────────────────

  describe('POST /api/v1/validations/end-scan-action', () => {
    it('applique un avertissement sur une présence sans scan de fin', async () => {
      const id = await insertCheckedInAttendance();
      const headers = await getAuthHeaders('director');

      const response = await request()
        .post('/api/v1/validations/end-scan-action')
        .set(headers)
        .send({ attendance_id: id, action: 'warned', reason: 'Scan de fin oublié' });

      expect(response.status).toBe(200);

      const rows = await queryTenant<{ end_scan_action: string }>(
        `SELECT end_scan_action FROM ${tenantTable('attendances_teacher')} WHERE id = $1`,
        [id]
      );
      expect(rows[0]?.end_scan_action).toBe('warned');
    });

    it('applique une sanction et rejette la présence', async () => {
      const id = await insertCheckedInAttendance();
      const headers = await getAuthHeaders('director');

      const response = await request()
        .post('/api/v1/validations/end-scan-action')
        .set(headers)
        .send({ attendance_id: id, action: 'sanctioned', reason: 'Absent confirmé' });

      expect(response.status).toBe(200);

      const rows = await queryTenant<{ end_scan_action: string; validation_status: string }>(
        `SELECT end_scan_action, validation_status FROM ${tenantTable('attendances_teacher')} WHERE id = $1`,
        [id]
      );
      expect(rows[0]?.end_scan_action).toBe('sanctioned');
      expect(rows[0]?.validation_status).toBe('rejected');
    });

    it('retourne 409 si une action active existe déjà', async () => {
      const id = await insertCheckedInAttendance();
      await queryTenant(
        `UPDATE ${tenantTable('attendances_teacher')} SET end_scan_action = 'warned', end_scan_action_at = NOW() WHERE id = $1`,
        [id]
      );
      const headers = await getAuthHeaders('director');

      const response = await request()
        .post('/api/v1/validations/end-scan-action')
        .set(headers)
        .send({ attendance_id: id, action: 'sanctioned', reason: 'Test' });

      expect(response.status).toBe(409);
    });

    it('retourne 400 pour une action invalide', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .post('/api/v1/validations/end-scan-action')
        .set(headers)
        .send({ attendance_id: randomUUID(), action: 'invalid', reason: 'Test' });

      expect(response.status).toBe(400);
    });
  });

  // ── POST /api/v1/validations/cancel-end-scan-sanction ────────────────────

  describe('POST /api/v1/validations/cancel-end-scan-sanction', () => {
    it('annule une sanction active et remet la présence en pending', async () => {
      const id = await insertCheckedInAttendance();
      const headers = await getAuthHeaders('director');

      // Appliquer d'abord une sanction
      await request()
        .post('/api/v1/validations/end-scan-action')
        .set(headers)
        .send({ attendance_id: id, action: 'sanctioned', reason: 'Absent confirmé' });

      const response = await request()
        .post('/api/v1/validations/cancel-end-scan-sanction')
        .set(headers)
        .send({ attendance_id: id, reason: 'Erreur de saisie' });

      expect(response.status).toBe(200);

      const rows = await queryTenant<{ end_scan_action_cancelled_at: string | null; validation_status: string }>(
        `SELECT end_scan_action_cancelled_at, validation_status FROM ${tenantTable('attendances_teacher')} WHERE id = $1`,
        [id]
      );
      expect(rows[0]?.end_scan_action_cancelled_at).not.toBeNull();
      expect(rows[0]?.validation_status).toBe('pending');
    });

    it("retourne 409 si aucune sanction active à annuler", async () => {
      const id = await insertCheckedInAttendance();
      const headers = await getAuthHeaders('director');

      const response = await request()
        .post('/api/v1/validations/cancel-end-scan-sanction')
        .set(headers)
        .send({ attendance_id: id, reason: 'Test annulation' });

      expect(response.status).toBe(409);
    });
  });

  // ── Teacher notifications ─────────────────────────────────────────────────

  describe('GET /api/v1/teacher/notifications', () => {
    it('retourne un tableau de notifications pour le prof', async () => {
      const headers = await getAuthHeaders('teacher');

      const response = await request()
        .get('/api/v1/teacher/notifications')
        .set(headers);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('retourne 403 pour un directeur', async () => {
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get('/api/v1/teacher/notifications')
        .set(headers);

      expect(response.status).toBe(403);
    });
  });

  describe('PATCH /api/v1/teacher/notifications/read-all', () => {
    it('marque toutes les notifications comme lues', async () => {
      const context = getSeedContext();
      const headers = await getAuthHeaders('teacher');

      // Insérer une notification non lue
      await queryTenant(
        `
          INSERT INTO ${tenantTable('notifications_log')} (
            type, channel, recipient_id, recipient_phone, recipient_email, message, status
          ) VALUES ('attendance_rejected', 'email', $1::uuid, '', null, 'Test message', 'queued')
        `,
        [context.teacherUserId]
      );

      const response = await request()
        .patch('/api/v1/teacher/notifications/read-all')
        .set(headers);

      expect(response.status).toBe(200);

      const rows = await queryTenant<{ read_at: string | null }>(
        `SELECT metadata->>'read_at' AS read_at FROM ${tenantTable('notifications_log')} WHERE recipient_id = $1::uuid`,
        [context.teacherUserId]
      );
      expect(rows.every((r) => r.read_at !== null)).toBe(true);
    });
  });
});
