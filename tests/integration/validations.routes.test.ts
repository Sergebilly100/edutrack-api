import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  queryPublic,
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

const ensureScheduleExceptionsTable = async (): Promise<void> => {
  await queryTenant(`
    CREATE TABLE IF NOT EXISTS ${tenantTable('schedule_exceptions')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      schedule_id uuid NOT NULL REFERENCES ${tenantTable('schedules')}(id) ON DELETE CASCADE,
      exception_date date NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
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

const insertEndScannedAttendanceWithoutCheckout = async (): Promise<string> => {
  const context = getSeedContext();
  const rows = await queryTenant<{ id: string }>(
    `
      INSERT INTO ${tenantTable('attendances_teacher')} (
        teacher_id,
        schedule_id,
        date,
        status,
        checked_in_at,
        room_scan_end_at,
        actual_minutes,
        validation_status,
        validated_hours
      )
      SELECT
        $1,
        $2,
        $3::date,
        'present',
        $3::date + ts.start_time + INTERVAL '1 minute',
        $3::date + ts.start_time + INTERVAL '4 minutes',
        NULL,
        'not_required',
        NULL
      FROM ${tenantTable('schedules')} s
      INNER JOIN ${tenantTable('time_slots')} ts ON ts.id = s.time_slot_id
      WHERE s.id = $2
      RETURNING id
    `,
    [context.teacherId, context.scheduleId, pastDate]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('[test] Failed to insert end-scanned attendance');
  return id;
};

const setUseRealHours = async (enabled: boolean): Promise<void> => {
  await queryPublic(
    `
      WITH tenant_row AS (
        INSERT INTO public.tenants (name, subdomain, schema_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (schema_name)
        DO UPDATE SET updated_at = NOW()
        RETURNING id
      )
      INSERT INTO public.school_sms_features (tenant_id, use_real_hours)
      SELECT id, $4
      FROM tenant_row
      ON CONFLICT ON CONSTRAINT school_sms_features_tenant_unique
      DO UPDATE SET use_real_hours = EXCLUDED.use_real_hours
    `,
    [`Integration ${TEST_SCHEMA_NAME}`, TEST_SCHEMA_NAME, TEST_SCHEMA_NAME, enabled]
  );
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('validations routes integration (real db)', () => {
  beforeEach(async () => {
    await ensureScheduleExceptionsTable();
  });

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

    it('remonte en heures courtes un scan de fin sans checkout ni actual_minutes', async () => {
      await setUseRealHours(true);
      const id = await insertEndScannedAttendanceWithoutCheckout();
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get('/api/v1/validations/pending')
        .set(headers);

      expect(response.status).toBe(200);
      const item = response.body.short_hours.find(
        (row: { attendanceId: string }) => row.attendanceId === id
      );
      expect(item).toMatchObject({
        attendanceId: id,
        kind: 'short_hours',
        actualMinutes: 3,
      });
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

    it('exclut du compteur missing_end_scan une session déjà tolérée (action active)', async () => {
      const headers = await getAuthHeaders('director');

      // Session sans scan de fin (pointé, pas de checkout ni room_scan_end_at, date passée).
      const id = await insertPendingAttendance();

      const before = await request()
        .get('/api/v1/validations/pending/count')
        .set(headers);
      expect(before.status).toBe(200);
      const countedBefore = before.body.missing_end_scan;
      expect(countedBefore).toBeGreaterThanOrEqual(1);

      // Le directeur tolère : action 'warned' active (non annulée) → "traité".
      await queryTenant(
        `UPDATE ${tenantTable('attendances_teacher')}
           SET end_scan_action = 'warned', end_scan_action_at = NOW(), end_scan_action_cancelled_at = NULL
         WHERE id = $1`,
        [id]
      );

      const after = await request()
        .get('/api/v1/validations/pending/count')
        .set(headers);
      expect(after.status).toBe(200);
      // La session traitée ne doit plus être comptée : le badge peut retomber à 0.
      expect(after.body.missing_end_scan).toBe(countedBefore - 1);

      // Annuler l'action la réintègre au compteur (cohérent avec countEligibleSessions).
      await queryTenant(
        `UPDATE ${tenantTable('attendances_teacher')}
           SET end_scan_action_cancelled_at = NOW()
         WHERE id = $1`,
        [id]
      );
      const reverted = await request()
        .get('/api/v1/validations/pending/count')
        .set(headers);
      expect(reverted.status).toBe(200);
      expect(reverted.body.missing_end_scan).toBe(countedBefore);

      // Nettoyage pour ne pas polluer les autres tests partageant le tenant seedé.
      await queryTenant(
        `DELETE FROM ${tenantTable('attendances_teacher')} WHERE id = $1`,
        [id]
      );
    });
  });

  // ── GET /api/v1/validations/history ─────────────────────────────────────

  describe('GET /api/v1/validations/history', () => {
    it('retourne les heures courtes validées quand aucun mois n’est fourni', async () => {
      const id = await insertPendingAttendance({
        validation_status: 'approved',
        validated_hours: 0.5,
        validated_at: '2024-03-15T10:00:00Z',
        geo_status: null,
      });
      const headers = await getAuthHeaders('director');

      try {
        const response = await request()
          .get('/api/v1/validations/history?kind=short_hours&page=1&limit=50')
          .set(headers);

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body.items)).toBe(true);
        expect(response.body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              attendanceId: id,
              kind: 'short_hours',
              actualMinutes: 30,
            }),
          ])
        );
      } finally {
        await queryTenant(
          `DELETE FROM ${tenantTable('attendances_teacher')} WHERE id = $1`,
          [id]
        );
      }
    });

    it('retourne les présences GPS suspectes quand aucun mois n’est fourni', async () => {
      const id = await insertPendingAttendance({
        actual_minutes: 120,
        validation_status: 'approved',
        validated_hours: 1,
        validated_at: '2024-03-15T10:00:00Z',
        geo_status: 'suspicious',
      });
      const headers = await getAuthHeaders('director');

      try {
        const response = await request()
          .get('/api/v1/validations/history?kind=gps_suspicious&page=1&limit=50')
          .set(headers);

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body.items)).toBe(true);
        expect(response.body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              attendanceId: id,
              kind: 'gps_suspicious',
              actualMinutes: 120,
            }),
          ])
        );
      } finally {
        await queryTenant(
          `DELETE FROM ${tenantTable('attendances_teacher')} WHERE id = $1`,
          [id]
        );
      }
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
    it('retourne les scans éligibles de tous les mois sans filtre', async () => {
      await insertCheckedInAttendance();
      const headers = await getAuthHeaders('director');

      const response = await request()
        .get('/api/v1/validations/missing-end-scans')
        .set(headers);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.arrayContaining([
        expect.objectContaining({ teacherId: getSeedContext().teacherId }),
      ]));
    });

    it('n’expose pas un scan de fin avant la tolérance de 30 minutes', async () => {
      const context = getSeedContext();
      const [slot] = await queryTenant<{ id: string; end_time: string }>(
        `SELECT ts.id::text, ts.end_time::text
         FROM ${tenantTable('schedules')} s
         INNER JOIN ${tenantTable('time_slots')} ts ON ts.id = s.time_slot_id
         WHERE s.id = $1`,
        [context.scheduleId]
      );
      if (!slot) throw new Error('[test] Missing schedule time slot');

      let attendanceId: string | null = null;
      try {
        await queryTenant(
          `UPDATE ${tenantTable('time_slots')}
           SET end_time = ((NOW() AT TIME ZONE 'Africa/Abidjan') + INTERVAL '10 minutes')::time
           WHERE id = $1`,
          [slot.id]
        );
        const rows = await queryTenant<{ id: string }>(
          `INSERT INTO ${tenantTable('attendances_teacher')} (
             teacher_id, schedule_id, date, checked_in_at, validation_status
           ) VALUES ($1, $2, CURRENT_DATE, NOW(), 'not_required')
           RETURNING id`,
          [context.teacherId, context.scheduleId]
        );
        attendanceId = rows[0]?.id ?? null;

        const response = await request()
          .get('/api/v1/validations/missing-end-scans')
          .set(await getAuthHeaders('director'));

        expect(response.status).toBe(200);
        expect(response.body.flatMap((teacher: { sessions: Array<{ attendanceId: string }> }) => teacher.sessions))
          .not.toEqual(expect.arrayContaining([expect.objectContaining({ attendanceId })]));
      } finally {
        await queryTenant(
          `UPDATE ${tenantTable('time_slots')} SET end_time = $2::time WHERE id = $1`,
          [slot.id, slot.end_time]
        );
        if (attendanceId) {
          await queryTenant(`DELETE FROM ${tenantTable('attendances_teacher')} WHERE id = $1`, [attendanceId]);
        }
      }
    });

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
