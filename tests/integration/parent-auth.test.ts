import argon2 from 'argon2';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryPublic,
  queryTenant,
  request,
  tenantTable,
  TEST_SCHEMA_NAME,
} from './setup.js';
import { NotificationsService } from '../../src/modules/notifications/notifications.service.js';
import { withTenantSchema } from '../../src/shared/database/db.js';
import { SubscriptionsRepository } from '../../src/modules/subscriptions/subscriptions.repository.js';

type TenantRow = { id: string };
type IdRow = { id: string };

const parentPhone = '2250709991111';
const parentPassword = '1111';
const week = '2026-W18';
const mondayDate = '2026-04-27';
const freeParentPhone = '2250709995555';
let tenantIdValue = '';
let paidSubscriptionId = '';
let scheduleIdForAlerts = '';

const loginParent = async (password = parentPassword) => {
  return request()
    .post('/api/v1/auth/login/parent')
    .set('x-tenant-schema', TEST_SCHEMA_NAME)
    .send({ phone: parentPhone, password });
};

describe('parent auth + parent routes integration', () => {
  let linkedStudentId = '';
  let otherStudentId = '';

  beforeAll(async () => {
    const context = getSeedContext();

    const tenantRows = await queryPublic<TenantRow>(
      `
        INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
        VALUES ($1, $2, $3, 'pro', 'active', 50, true)
        ON CONFLICT (schema_name)
        DO UPDATE SET updated_at = NOW()
        RETURNING id::text
      `,
      ['Integration Parent School', `integration-parent-${Date.now()}`, TEST_SCHEMA_NAME]
    );
    const tenantId = tenantRows[0]!.id;
    tenantIdValue = tenantId;

    await queryPublic(
      `
        INSERT INTO public.school_sms_features (tenant_id, is_enabled, commission_pct, sms_cap_per_student, sms_unit_price_fcfa, monetize_parent_alerts)
        VALUES ($1::uuid, true, 15.00, 60, 1000, true)
        ON CONFLICT (tenant_id)
        DO UPDATE SET
          is_enabled = EXCLUDED.is_enabled,
          sms_unit_price_fcfa = EXCLUDED.sms_unit_price_fcfa,
          monetize_parent_alerts = EXCLUDED.monetize_parent_alerts
      `,
      [tenantId]
    );

    const classIdRows = await queryTenant<IdRow>(`SELECT id::text AS id FROM ${tenantTable('classes')} LIMIT 1`);
    const classId = classIdRows[0]!.id;
    const yearId = (await queryTenant<IdRow>(`INSERT INTO ${tenantTable('school_years')}
      (label,start_date,end_date,status) VALUES ('Parent auth','2026-01-01','2028-12-31','active') RETURNING id::text`))[0]!.id;
    await queryTenant(`UPDATE ${tenantTable('classes')} SET school_year_id=$1::uuid WHERE id=$2::uuid`, [yearId, classId]);

    const studentRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('students')} (
          class_id, first_name, last_name, parent_phone, parent_phone_2, is_active
        )
        VALUES
          ($1::uuid, 'Linked', 'Student', '2250700000001', NULL, true),
          ($1::uuid, 'Other', 'Student', $2, NULL, true)
        RETURNING id::text
      `,
      [classId, freeParentPhone]
    );
    linkedStudentId = studentRows[0]!.id;
    otherStudentId = studentRows[1]!.id;
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id,class_id,school_year_id,type,status)
      VALUES ($1::uuid,$3::uuid,$4::uuid,'new_registration','confirmed'),
             ($2::uuid,$3::uuid,$4::uuid,'new_registration','confirmed')`,
    [linkedStudentId, otherStudentId, classId, yearId]);

    const parentHash = await argon2.hash(parentPassword);
    const parentRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('parents')} (full_name, phone, email, password_hash, must_change_password, is_active)
        VALUES ('Parent Linked', $1, 'parent@test.ci', $2, false, true)
        RETURNING id::text AS id
      `,
      [parentPhone, parentHash]
    );
    const parentId = parentRows[0]!.id;

    const subscriptionRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('parent_subscriptions')} (
          parent_id,
          unit_price_fcfa,
          student_count,
          total_amount_fcfa,
          duration_months,
          starts_at,
          ends_at,
          status,
          auto_renew_alert,
          renewed_count,
          created_by
        )
        VALUES ($1::uuid, 1000, 1, 1000, 1, CURRENT_DATE - INTERVAL '1 day', CURRENT_DATE + INTERVAL '30 day', 'active', false, 0, $2::uuid)
        RETURNING id::text AS id
      `,
      [parentId, context.directorUserId]
    );
    const subscriptionId = subscriptionRows[0]!.id;
    paidSubscriptionId = subscriptionId;

    await queryTenant(
      `
        INSERT INTO ${tenantTable('parent_student_links')} (subscription_id, parent_id, student_id)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `,
      [subscriptionId, parentId, linkedStudentId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('parent_student_links')} (subscription_id, parent_id, student_id)
       VALUES (NULL, $1::uuid, $2::uuid)`,
      [parentId, otherStudentId]
    );

    const slotRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('time_slots')} (label, start_time, end_time, sort_order)
        VALUES ('parent-slot', '08:00:00'::time, '09:00:00'::time, 1)
        RETURNING id::text AS id
      `
    );
    const slotId = slotRows[0]!.id;

    const periodRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('schedule_periods')} (name, valid_from, valid_to, is_active, created_by)
        VALUES ('Parent Test Period', '2026-04-27'::date, '2026-05-03'::date, true, $1::uuid)
        RETURNING id::text AS id
      `,
      [context.directorUserId]
    );
    const periodId = periodRows[0]!.id;

    const levelId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index) VALUES ('Parent auth level', 1) RETURNING id::text AS id`
    ))[0]!.id;
    await queryTenant(`UPDATE ${tenantTable('classes')} SET level_id = $1::uuid WHERE id = $2::uuid`, [levelId, classId]);
    const subjectId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('subjects')} (level_id, name, coefficient) VALUES ($1::uuid, 'Mathematiques', 1) RETURNING id::text AS id`,
      [levelId]
    ))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('teacher_subject_assignments')} (teacher_id, class_id, subject_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [context.teacherId, classId, subjectId]
    );

    const scheduleRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('schedules')} (
          schedule_period_id,
          teacher_id,
          class_id,
          room_id,
          time_slot_id,
          day_of_week,
          subject,
          subject_id,
          is_active
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          (SELECT id FROM ${tenantTable('rooms')} LIMIT 1),
          $4::uuid,
          1,
          'Mathematiques',
          $5::uuid,
          true
        )
        RETURNING id::text AS id
      `,
      [periodId, context.teacherId, classId, slotId, subjectId]
    );
    scheduleIdForAlerts = scheduleRows[0]!.id;

    await queryTenant(
      `
        INSERT INTO ${tenantTable('attendances_student')} (student_id, schedule_id, date, status)
        SELECT $1::uuid, s.id, $2::date, 'absent'
        FROM ${tenantTable('schedules')} s
        WHERE s.schedule_period_id = $3::uuid
        LIMIT 1
      `,
      [linkedStudentId, mondayDate, periodId]
    );
  });

  it('POST /auth/login/parent avec bons credentials → JWT role=parent', async () => {
    const response = await loginParent();
    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.user?.role).toBe('parent');
    expect(response.body.user?.mustChangePassword).toBe(false);
  });

  it('POST /auth/login/parent avec mauvais mdp → 401', async () => {
    const response = await loginParent('wrong-password');
    expect(response.status).toBe(401);
  });

  it('POST /auth/login/parent refuse un lien dont la souscription est expirée', async () => {
    const expiredPhone = '2250709992222';
    const expiredHash = await argon2.hash('2222');

    const parentRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('parents')} (full_name, phone, password_hash, must_change_password, is_active)
        VALUES ('Parent Expired', $1, $2, false, true)
        RETURNING id::text AS id
      `,
      [expiredPhone, expiredHash]
    );
    const parentId = parentRows[0]!.id;
    const context = getSeedContext();

    await queryTenant(
      `
        INSERT INTO ${tenantTable('parent_subscriptions')} (
          parent_id, unit_price_fcfa, student_count, total_amount_fcfa, duration_months,
          starts_at, ends_at, status, created_by
        )
        VALUES ($1::uuid, 1000, 1, 1000, 1, CURRENT_DATE - INTERVAL '60 day', CURRENT_DATE - INTERVAL '1 day', 'expired', $2::uuid)
      `,
      [parentId, context.directorUserId]
    );
    await queryTenant(
      `
        INSERT INTO ${tenantTable('parent_student_links')} (subscription_id, parent_id, student_id)
        VALUES (NULL, $1::uuid, $2::uuid)
      `,
      [parentId, otherStudentId]
    );

    const response = await request()
      .post('/api/v1/auth/login/parent')
      .set('x-tenant-schema', TEST_SCHEMA_NAME)
      .send({ phone: expiredPhone, password: '2222' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PARENT_PORTAL_ACCESS_DENIED');
  });

  it('POST /auth/login/parent refuse l’accès quand la fonctionnalité parent est désactivée', async () => {
    await queryPublic(
      `UPDATE public.school_sms_features SET is_enabled = false WHERE tenant_id = (SELECT id FROM public.tenants WHERE schema_name = $1 LIMIT 1)`,
      [TEST_SCHEMA_NAME]
    );

    try {
      const response = await loginParent();
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PARENT_PORTAL_ACCESS_DENIED');
    } finally {
      await queryPublic(
        `UPDATE public.school_sms_features SET is_enabled = true WHERE tenant_id = (SELECT id FROM public.tenants WHERE schema_name = $1 LIMIT 1)`,
        [TEST_SCHEMA_NAME]
      );
    }
  });

  it('GET /parent/students retourne seulement les élèves du parent', async () => {
    const loginResponse = await loginParent();
    const token = loginResponse.body.accessToken;

    const response = await request()
      .get('/api/v1/parent/students')
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].id).toBe(linkedStudentId);
  });

  it('GET /parent/students/:id avec élève non rattaché → 403', async () => {
    const loginResponse = await loginParent();
    const token = loginResponse.body.accessToken;

    const response = await request()
      .get(`/api/v1/parent/students/${otherStudentId}/stats`)
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('STUDENT_ACCESS_DENIED');
  });

  it('autorise un parent lié sans souscription en mode gratuit actif', async () => {
    const hash = await argon2.hash(parentPassword);
    const parentRows = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('parents')}
        (full_name, phone, password_hash, must_change_password, is_active)
       VALUES ('Parent Free', $1, $2, false, true)
       RETURNING id::text AS id`,
      [freeParentPhone, hash]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('parent_student_links')} (parent_id, student_id, subscription_id)
       VALUES ($1::uuid, $2::uuid, NULL)`,
      [parentRows[0]!.id, otherStudentId]
    );
    await queryPublic(
      `UPDATE public.school_sms_features SET is_enabled = true, monetize_parent_alerts = false
       WHERE tenant_id = $1::uuid`,
      [tenantIdValue]
    );

    try {
      const login = await request()
        .post('/api/v1/auth/login/parent')
        .set('x-tenant-schema', TEST_SCHEMA_NAME)
        .send({ phone: freeParentPhone, password: parentPassword });
      expect(login.status).toBe(200);
      expect(login.body.user.studentIds).toEqual([otherStudentId]);

      const students = await request()
        .get('/api/v1/parent/students')
        .set('authorization', `Bearer ${login.body.accessToken}`);
      expect(students.status).toBe(200);
      expect(students.body.data.map((student: { id: string }) => student.id)).toEqual([otherStudentId]);
    } finally {
      await queryPublic(
        `UPDATE public.school_sms_features SET is_enabled = true, monetize_parent_alerts = true
         WHERE tenant_id = $1::uuid`,
        [tenantIdValue]
      );
    }
  });

  it('réévalue l’accès protégé après annulation de la souscription', async () => {
    const login = await loginParent();
    expect(login.status).toBe(200);

    await queryTenant(
      `UPDATE ${tenantTable('parent_subscriptions')} SET status = 'cancelled' WHERE id = $1::uuid`,
      [paidSubscriptionId]
    );
    try {
      const response = await request()
        .get('/api/v1/parent/students')
        .set('authorization', `Bearer ${login.body.accessToken}`);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PARENT_PORTAL_ACCESS_DENIED');
    } finally {
      await queryTenant(
        `UPDATE ${tenantTable('parent_subscriptions')} SET status = 'active' WHERE id = $1::uuid`,
        [paidSubscriptionId]
      );
    }
  });

  it('GET /parent/subscription/status retourne les données attendues', async () => {
    const loginResponse = await loginParent();
    const token = loginResponse.body.accessToken;

    const response = await request()
      .get('/api/v1/parent/subscription/status')
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.subscription.status).toBeTruthy();
    expect(response.body.subscription.ends_at).toBeTruthy();
    expect(typeof response.body.subscription.days_remaining).toBe('number');
    expect(response.body.offer).toMatchObject({ billing: 'per_child_per_month' });
  });

  it('GET /parent/students/:id/schedule retourne l\'EDT avec statuts corrects', async () => {
    const loginResponse = await loginParent();
    const token = loginResponse.body.accessToken;

    const response = await request()
      .get(`/api/v1/parent/students/${linkedStudentId}/schedule?week=${week}`)
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('week_label', week);
    expect(Array.isArray(response.body.days)).toBe(true);

    const allSlots = response.body.days.flatMap((day: { slots: Array<{ status: string }> }) => day.slots);
    expect(allSlots.length).toBeGreaterThan(0);
    const allowedStatuses = new Set(['present', 'absent', 'upcoming', 'unknown']);
    expect(allSlots.every((slot: { status: string }) => allowedStatuses.has(slot.status))).toBe(true);
  });

  it('refuse sans souscription en mode payant et retourne subscription:null en mode gratuit', async () => {
    const phone = '2250700000001'; // contact 1 de linkedStudent
    const parents = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('parents')} (full_name, phone, password_hash, must_change_password, is_active)
       VALUES ('Parent sans abonnement', $1, $2, false, true) RETURNING id::text`,
      [phone, await argon2.hash(parentPassword)]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('parent_student_links')} (parent_id, student_id, subscription_id) VALUES ($1, $2, NULL)`,
      [parents[0]!.id, linkedStudentId]
    );
    const paidLogin = await request().post('/api/v1/auth/login/parent').set('x-tenant-schema', TEST_SCHEMA_NAME)
      .send({ phone, password: parentPassword });
    expect(paidLogin.status).toBe(403);
    expect(paidLogin.body.code).toBe('PARENT_PORTAL_ACCESS_DENIED');

    await queryPublic(
      `UPDATE public.school_sms_features SET is_enabled = true, monetize_parent_alerts = false
       WHERE tenant_id = $1::uuid`,
      [tenantIdValue]
    );
    const login = await request().post('/api/v1/auth/login/parent').set('x-tenant-schema', TEST_SCHEMA_NAME)
      .send({ phone, password: parentPassword });
    expect(login.status).toBe(200);
    try {
      for (const [enabled, monetized, price, available] of [
        [true, false, 1250, false],
      ] as const) {
        await queryPublic(`UPDATE public.school_sms_features SET is_enabled=$1, monetize_parent_alerts=$2, sms_unit_price_fcfa=$3
          WHERE tenant_id=(SELECT id FROM public.tenants WHERE schema_name=$4)`, [enabled, monetized, price, TEST_SCHEMA_NAME]);
        const response = await request().get('/api/v1/parent/subscription/status')
          .set('authorization', `Bearer ${login.body.accessToken}`);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ subscription: null, offer: {
          available, unit_price_fcfa: available ? price : null, billing: 'per_child_per_month',
        } });
      }
    } finally {
      await queryPublic(`UPDATE public.school_sms_features SET is_enabled=true, monetize_parent_alerts=true, sms_unit_price_fcfa=1000
        WHERE tenant_id=(SELECT id FROM public.tenants WHERE schema_name=$1)`, [TEST_SCHEMA_NAME]);
    }
  });

  it('mode gratuit : un parent lié qui n’est pas le contact 1 est refusé au portail', async () => {
    const phone = '2250709997777';
    const [{ id }] = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('parents')} (full_name, phone, password_hash, must_change_password, is_active)
       VALUES ('Lié non principal', $1, $2, false, true) RETURNING id::text AS id`,
      [phone, await argon2.hash(parentPassword)]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('parent_student_links')} (parent_id, student_id, subscription_id) VALUES ($1::uuid, $2::uuid, NULL)`,
      [id, linkedStudentId]
    );
    await queryPublic(
      `UPDATE public.school_sms_features SET is_enabled = true, monetize_parent_alerts = false WHERE tenant_id = $1::uuid`,
      [tenantIdValue]
    );
    try {
      const login = await request().post('/api/v1/auth/login/parent').set('x-tenant-schema', TEST_SCHEMA_NAME)
        .send({ phone, password: parentPassword });
      expect(login.status).toBe(403);
      expect(login.body.code).toBe('PARENT_PORTAL_ACCESS_DENIED');
    } finally {
      await queryPublic(
        `UPDATE public.school_sms_features SET is_enabled = true, monetize_parent_alerts = true WHERE tenant_id = $1::uuid`,
        [tenantIdValue]
      );
    }
  });

  it('Parent avec mot de passe temporaire: accès bloqué hors /auth/change-password, puis accès rétabli', async () => {
    const forcedPhone = '2250709993333';
    const tempPassword = '3333';
    const newPassword = 'NewPass1234';
    const forcedHash = await argon2.hash(tempPassword);

    const parentRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('parents')} (full_name, phone, password_hash, must_change_password, is_active)
        VALUES ('Parent Forced', $1, $2, true, true)
        RETURNING id::text AS id
      `,
      [forcedPhone, forcedHash]
    );
    const parentId = parentRows[0]!.id;
    const context = getSeedContext();

    const subscriptionRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('parent_subscriptions')} (
          parent_id,
          unit_price_fcfa,
          student_count,
          total_amount_fcfa,
          duration_months,
          starts_at,
          ends_at,
          status,
          auto_renew_alert,
          renewed_count,
          created_by
        )
        VALUES ($1::uuid, 1000, 1, 1000, 1, CURRENT_DATE - INTERVAL '1 day', CURRENT_DATE + INTERVAL '30 day', 'active', false, 0, $2::uuid)
        RETURNING id::text AS id
      `,
      [parentId, context.directorUserId]
    );
    const subscriptionId = subscriptionRows[0]!.id;

    await queryTenant(
      `
        INSERT INTO ${tenantTable('parent_student_links')} (subscription_id, parent_id, student_id)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `,
      [subscriptionId, parentId, linkedStudentId]
    );

    const loginResponse = await request()
      .post('/api/v1/auth/login/parent')
      .set('x-tenant-schema', TEST_SCHEMA_NAME)
      .send({ phone: forcedPhone, password: tempPassword });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.user?.mustChangePassword).toBe(true);
    const token = loginResponse.body.accessToken;

    const blocked = await request()
      .get('/api/v1/parent/students')
      .set('authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await request()
      .post('/api/v1/parent/auth/change-password')
      .set('authorization', `Bearer ${token}`)
      .send({
        current_password: tempPassword,
        new_password: newPassword,
      });
    expect(changed.status).toBe(200);

    const allowed = await request()
      .get('/api/v1/parent/students')
      .set('authorization', `Bearer ${token}`);
    expect(allowed.status).toBe(200);
  });

  it('file le contact 2 et les parents liés en gratuit, puis filtre par abonnement actif en payant', async () => {
    const unbilledPhone = '2250709996666';
    const [{ id: linkedClassId }] = await queryTenant<IdRow>(
      `SELECT class_id::text AS id FROM ${tenantTable('students')} WHERE id = $1::uuid`,
      [linkedStudentId]
    );
    const alertStudent = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')}
        (class_id, first_name, last_name, parent_phone, parent_phone_2, is_active)
       VALUES ($1::uuid, 'Alert', 'Student', NULL, $2, true)
       RETURNING id::text AS id`,
      [linkedClassId, parentPhone]
    );
    const alertStudentId = alertStudent[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
       VALUES (
         $1::uuid,
         $2::uuid,
         (SELECT id FROM ${tenantTable('school_years')} WHERE status = 'active' LIMIT 1),
         'new_registration',
         'confirmed'
       )`,
      [alertStudentId, linkedClassId]
    );
    const [{ id: billedParentId }] = await queryTenant<IdRow>(
      `SELECT id::text AS id FROM ${tenantTable('parents')} WHERE phone = $1`,
      [parentPhone]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('parent_student_links')} (parent_id, student_id, subscription_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [billedParentId, alertStudentId, paidSubscriptionId]
    );
    const unbilledParent = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('parents')}
        (full_name, phone, password_hash, must_change_password, is_active)
       VALUES ('Parent sans abonnement alerte', $1, $2, false, true)
       RETURNING id::text AS id`,
      [unbilledPhone, await argon2.hash(parentPassword)]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('parent_student_links')} (parent_id, student_id, subscription_id)
       VALUES ($1::uuid, $2::uuid, NULL)`,
      [unbilledParent[0]!.id, alertStudentId]
    );

    const queuedJobs: Array<{ name: string; data: { to?: string } }> = [];
    const service = new NotificationsService({
      withTenantSchema,
      smsQueue: {
        add: async (name: string, data: { to?: string }) => {
          queuedJobs.push({ name, data });
          return { id: `test-${queuedJobs.length}` };
        },
      } as never,
    });
    const payload = {
      tenantId: tenantIdValue,
      schemaName: TEST_SCHEMA_NAME,
      studentId: alertStudentId,
      scheduleId: scheduleIdForAlerts,
      studentFirstName: 'Linked',
      parentPhone: '',
      parentPhone2: parentPhone,
      subject: 'Mathematiques',
      date: mondayDate,
      schoolPhone: '2250701234567',
    };

    try {
      await queryPublic(
        `UPDATE public.school_sms_features SET is_enabled = true, monetize_parent_alerts = false
         WHERE tenant_id = $1::uuid`,
        [tenantIdValue]
      );
      await service.handleStudentAbsent(payload);

      const freeSms = queuedJobs.filter((job) => job.name === 'send-sms');
      // Gratuit : le parent lié non principal n'est pas alerté ; le contact 2 sert de repli (contact 1 vide).
      expect(freeSms.map((job) => job.data.to)).toEqual([parentPhone]);
      expect(new Set(freeSms.map((job) => job.data.to)).size).toBe(freeSms.length);

      const freeStatuses = await queryTenant<{ recipient_phone: string; status: string }>(
        `SELECT recipient_phone, status FROM ${tenantTable('notifications_log')}
         WHERE related_id = $1::uuid AND type = 'student_absent_parent' AND channel = 'sms'
         ORDER BY created_at`,
        [scheduleIdForAlerts]
      );
      expect(freeStatuses).toContainEqual({ recipient_phone: parentPhone, status: 'queued' });
      expect(freeStatuses.map((row) => row.recipient_phone)).not.toContain(unbilledPhone);

      queuedJobs.length = 0;
      await queryPublic(
        `UPDATE public.school_sms_features SET is_enabled = true, monetize_parent_alerts = true
         WHERE tenant_id = $1::uuid`,
        [tenantIdValue]
      );
      await service.handleStudentAbsent(payload);

      const paidSms = queuedJobs.filter((job) => job.name === 'send-sms');
      expect(paidSms.map((job) => job.data.to)).toEqual([parentPhone]);
      const paidStatuses = await queryTenant<{ recipient_phone: string; status: string }>(
        `SELECT recipient_phone, status FROM ${tenantTable('notifications_log')}
         WHERE related_id = $1::uuid AND type = 'student_absent_parent' AND channel = 'sms'
           AND status IN ('skipped_no_active_subscription', 'skipped_subscription_expired')
         ORDER BY created_at`,
        [scheduleIdForAlerts]
      );
      expect(paidStatuses).toContainEqual({
        recipient_phone: unbilledPhone,
        status: 'skipped_no_active_subscription',
      });
    } finally {
      await queryPublic(
        `UPDATE public.school_sms_features SET is_enabled = true, monetize_parent_alerts = true
         WHERE tenant_id = $1::uuid`,
        [tenantIdValue]
      );
    }
  });
});

describe('parent provisioning on student enrollment', () => {
  let pendingParentId = '';

  // L'envoi des accès par l'école n'existe qu'en mode gratuit (C46) ; en payant, il passe par les abonnements.
  beforeAll(async () => {
    await queryPublic(
      `UPDATE public.school_sms_features SET is_enabled = true, monetize_parent_alerts = false WHERE tenant_id = $1::uuid`,
      [tenantIdValue]
    );
  });

  it('création élève → parent créé, lié et SMS d’accès mis en file', async () => {
    const headers = await getAuthHeaders('director');
    const [{ id: classId }] = await queryTenant<{ id: string }>(
      `SELECT id::text AS id FROM ${tenantTable('classes')} ORDER BY created_at ASC LIMIT 1`
    );
    const suffix = Math.random().toString().slice(2, 9).padEnd(7, '0');
    const phone = `22507${suffix}1`;

    const response = await request()
      .post('/api/v1/students')
      .set(headers)
      .send({
        class_id: classId,
        first_name: 'Provisioning',
        last_name: `Student-${suffix}`,
        parent_name: `Parent ${suffix}`,
        parent_phone: phone,
        parent_email: `parent-${suffix}@test.ci`,
      });

    expect(response.status).toBe(201);
    const studentId = response.body.data.id as string;

    const rows = await queryTenant<{
      parent_id: string;
      phone: string;
      must_change_password: boolean;
      access_sent_at: string | null;
      subscription_id: string | null;
    }>(
      `
        SELECT
          p.id::text AS parent_id,
          p.phone,
          p.must_change_password,
          p.access_sent_at::text,
          psl.subscription_id::text
        FROM ${tenantTable('parents')} p
        INNER JOIN ${tenantTable('parent_student_links')} psl ON psl.parent_id = p.id
        WHERE p.phone = $1 AND psl.student_id = $2::uuid
      `,
      [phone, studentId]
    );

    expect(rows).toHaveLength(1);
    pendingParentId = rows[0]!.parent_id;
    expect(rows[0]).toMatchObject({
      phone,
      must_change_password: true,
      access_sent_at: null,
      subscription_id: null,
    });

    const notifications = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('notifications_log')}
        WHERE type = 'parent_access_credentials'
          AND related_id = $1::uuid
          AND status = 'queued'
      `,
      [rows[0]!.parent_id]
    );
    expect(notifications[0]?.count).toBe(1);
  });

  it('endpoint d’envoi différé accepte plusieurs IDs et met les accès en file', async () => {
    const headers = await getAuthHeaders('director');
    const missingId = '33333333-3333-4333-8333-333333333333';

    const response = await request()
      .post('/api/v1/subscriptions/parents/access/send')
      .set(headers)
      .send({ parent_ids: [pendingParentId, missingId] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.queued).toBe(1);
    expect(response.body.items).toEqual([
      { parentId: pendingParentId, status: 'queued' },
      { parentId: missingId, status: 'not_found' },
    ]);
  });

  it('deux élèves avec le même téléphone partagent un seul compte parent', async () => {
    const headers = await getAuthHeaders('director');
    const [{ id: classId }] = await queryTenant<{ id: string }>(
      `SELECT id::text AS id FROM ${tenantTable('classes')} ORDER BY created_at ASC LIMIT 1`
    );
    const suffix = Math.random().toString().slice(2, 9).padEnd(7, '0');
    const phone = `22505${suffix}2`;

    for (const index of [1, 2]) {
      const response = await request()
        .post('/api/v1/students')
        .set(headers)
        .send({
          class_id: classId,
          first_name: `Sibling-${index}`,
          last_name: suffix,
          parent_name: `Parent ${suffix}`,
          parent_phone: phone,
        });
      expect(response.status).toBe(201);
    }

    const [result] = await queryTenant<{ parents_count: number; links_count: number }>(
      `
        SELECT
          COUNT(DISTINCT p.id)::int AS parents_count,
          COUNT(psl.id)::int AS links_count
        FROM ${tenantTable('parents')} p
        INNER JOIN ${tenantTable('parent_student_links')} psl ON psl.parent_id = p.id
        WHERE p.phone = $1
      `,
      [phone]
    );

    expect(result).toEqual({ parents_count: 1, links_count: 2 });
  });

  it('mise à jour élève avec contact principal → crée et lie le parent', async () => {
    const headers = await getAuthHeaders('director');
    const [{ id: classId }] = await queryTenant<{ id: string }>(
      `SELECT id::text AS id FROM ${tenantTable('classes')} ORDER BY created_at ASC LIMIT 1`
    );
    const suffix = Math.random().toString().slice(2, 9).padEnd(7, '0');
    const phone = `22509${suffix}3`;
    const created = await request()
      .post('/api/v1/students')
      .set(headers)
      .send({
        class_id: classId,
        first_name: 'ContactLater',
        last_name: suffix,
      });
    expect(created.status).toBe(201);

    const updated = await request()
      .put(`/api/v1/students/${created.body.data.id}`)
      .set(headers)
      .send({
        parent_name: `Parent Later ${suffix}`,
        parent_phone: phone,
      });

    expect(updated.status).toBe(200);
    const [{ count }] = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('parents')} p
        INNER JOIN ${tenantTable('parent_student_links')} psl ON psl.parent_id = p.id
        WHERE p.phone = $1 AND psl.student_id = $2::uuid
      `,
      [phone, created.body.data.id]
    );
    expect(count).toBe(1);
  });
  it('mode gratuit : crée le compte du seul parent principal (jamais du contact 2) sans erreur 500 (liste, détail, envoi groupé)', async () => {
    const headers = await getAuthHeaders('director');
    try {
      const [{ id: classId, school_year_id: yearId }] = await queryTenant<{ id: string; school_year_id: string }>(
        `SELECT c.id::text AS id, c.school_year_id::text AS school_year_id
         FROM ${tenantTable('classes')} c
         INNER JOIN ${tenantTable('school_years')} sy ON sy.id = c.school_year_id AND sy.status = 'active'
         ORDER BY c.created_at ASC LIMIT 1`
      );
      const suffix = Math.random().toString().slice(2, 8).padEnd(6, '0');
      const phone1 = `22507${suffix}11`;
      const phone2 = `22505${suffix}22`;
      // Élève confirmé dont les contacts existent mais sans compte parent ni lien
      // (création hors parcours standard : import historique, seed, contact 2).
      const [{ id: studentId }] = await queryTenant<{ id: string }>(
        `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, parent_name, parent_phone, parent_name_2, parent_phone_2, is_active)
         VALUES ($1::uuid, 'Legacy', $2, 'Parent Un', $3, NULL, $4, true) RETURNING id::text AS id`,
        [classId, `Contacts-${suffix}`, phone1, phone2]
      );
      await queryTenant(
        `INSERT INTO ${tenantTable('enrollments')} (student_id,class_id,school_year_id,type,status)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'new_registration','confirmed')`,
        [studentId, classId, yearId]
      );

      const detail = await request().get(`/api/v1/students/${studentId}/parent-access`).set(headers);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body.available).toBe(true);
      expect((detail.body.parents as Array<{ phone: string }>).map((parent) => parent.phone))
        .toEqual([phone1]);

      // Un compte lié à l'élève mais qui n'est pas le contact 1 n'est jamais proposé.
      const [{ id: strayId }] = await queryTenant<{ id: string }>(
        `INSERT INTO ${tenantTable('parents')} (full_name, phone, password_hash, must_change_password, is_active)
         VALUES ('Contact 2 legacy', $1, 'x', true, true) RETURNING id::text AS id`, [phone2]
      );
      await queryTenant(
        `INSERT INTO ${tenantTable('parent_student_links')} (parent_id, student_id, subscription_id) VALUES ($1::uuid, $2::uuid, NULL)`,
        [strayId, studentId]
      );
      const detailAgain = await request().get(`/api/v1/students/${studentId}/parent-access`).set(headers);
      expect((detailAgain.body.parents as Array<{ phone: string }>).map((parent) => parent.phone)).toEqual([phone1]);
      const resetStray = await request()
        .post(`/api/v1/students/${studentId}/parents/${strayId}/access/reset`).set(headers)
        .send({ channels: [], manual_only: true });
      expect(resetStray.status).toBe(404);
      await queryTenant(`DELETE FROM ${tenantTable('parent_student_links')} WHERE parent_id = $1::uuid`, [strayId]);
      await queryTenant(`DELETE FROM ${tenantTable('parents')} WHERE id = $1::uuid`, [strayId]);

      const send = await request().post('/api/v1/students/parents/access/send').set(headers);
      expect(send.status, JSON.stringify(send.body)).toBe(200);
      expect(send.body.items.length).toBeGreaterThanOrEqual(2);

      const [{ count }] = await queryTenant<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM ${tenantTable('parent_student_links')} WHERE student_id = $1::uuid`,
        [studentId]
      );
      expect(count).toBe(1);
      const [{ count: contact2Accounts }] = await queryTenant<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM ${tenantTable('parents')} WHERE phone = $1`,
        [phone2]
      );
      expect(contact2Accounts).toBe(0);
    } finally {
      await queryTenant(`DELETE FROM ${tenantTable('students')} WHERE last_name LIKE 'Contacts-%'`);
    }
  });
  it('contact 2 : destinataire d’alerte uniquement si le contact 1 est vide', async () => {
    const [{ id: classId, school_year_id: yearId }] = await queryTenant<{ id: string; school_year_id: string }>(
      `SELECT c.id::text AS id, c.school_year_id::text AS school_year_id
       FROM ${tenantTable('classes')} c
       INNER JOIN ${tenantTable('school_years')} sy ON sy.id = c.school_year_id AND sy.status = 'active'
       ORDER BY c.created_at ASC LIMIT 1`
    );
    const suffix = Math.random().toString().slice(2, 8).padEnd(6, '0');
    const phone1 = `22507${suffix}33`;
    const phone2 = `22505${suffix}44`;
    const create = async (name: string, p1: string | null) => {
      const [{ id }] = await queryTenant<{ id: string }>(
        `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, parent_phone, parent_phone_2, is_active)
         VALUES ($1::uuid, $2, $3, $4, $5, true) RETURNING id::text AS id`,
        [classId, name, `Fallback-${suffix}`, p1, phone2]
      );
      await queryTenant(
        `INSERT INTO ${tenantTable('enrollments')} (student_id,class_id,school_year_id,type,status)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'new_registration','confirmed')`,
        [id, classId, yearId]
      );
      return id;
    };
    try {
      const withContact1 = await create('WithC1', phone1);
      const withoutContact1 = await create('NoC1', null);
      const phonesOf = (studentId: string) => withTenantSchema(TEST_SCHEMA_NAME, async (tenantDb) =>
        (await new SubscriptionsRepository(tenantDb as never).listParentAlertContactsByStudent(studentId))
          .map((contact) => contact.parent_phone));
      expect(await phonesOf(withContact1)).toEqual([phone1]);
      expect(await phonesOf(withoutContact1)).toEqual([phone2]);
    } finally {
      await queryTenant(`DELETE FROM ${tenantTable('students')} WHERE last_name = $1`, [`Fallback-${suffix}`]);
    }
  });
  it('changement du contact 1 : l’ancien parent perd l’accès, le nouveau a un mot de passe temporaire', async () => {
    const headers = await getAuthHeaders('director');
    const [{ id: classId, school_year_id: yearId }] = await queryTenant<{ id: string; school_year_id: string }>(
      `SELECT c.id::text AS id, c.school_year_id::text AS school_year_id
       FROM ${tenantTable('classes')} c
       INNER JOIN ${tenantTable('school_years')} sy ON sy.id = c.school_year_id AND sy.status = 'active'
       ORDER BY c.created_at ASC LIMIT 1`
    );
    const suffix = Math.random().toString().slice(2, 8).padEnd(6, '0');
    const oldPhone = `22507${suffix}55`;
    const newPhone = `22505${suffix}66`;
    const created = await request().post('/api/v1/students').set(headers).send({
      class_id: classId, first_name: 'Swap', last_name: `Primary-${suffix}`,
      parent_name: 'Ancien Parent', parent_phone: oldPhone,
    });
    expect(created.status).toBe(201);
    const studentId = created.body.data.id as string;
    await queryTenant(
      `INSERT INTO ${tenantTable('enrollments')} (student_id,class_id,school_year_id,type,status)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'new_registration','confirmed')`,
      [studentId, classId, yearId]
    );
    await queryTenant(
      `UPDATE ${tenantTable('parents')} SET password_hash = $2, must_change_password = false WHERE phone = $1`,
      [oldPhone, await argon2.hash('OldPass-1234')]
    );
    const login = (phone: string, password: string) => request().post('/api/v1/auth/login/parent')
      .set('x-tenant-schema', TEST_SCHEMA_NAME).send({ phone, password });
    try {
      expect((await login(oldPhone, 'OldPass-1234')).status).toBe(200);

      const updated = await request().put(`/api/v1/students/${studentId}`).set(headers)
        .send({ parent_name: 'Nouveau Parent', parent_phone: newPhone });
      expect(updated.status).toBe(200);

      expect((await login(oldPhone, 'OldPass-1234')).status).not.toBe(200);
      const links = await queryTenant<{ phone: string }>(
        `SELECT p.phone FROM ${tenantTable('parent_student_links')} psl
         INNER JOIN ${tenantTable('parents')} p ON p.id = psl.parent_id WHERE psl.student_id = $1::uuid`,
        [studentId]
      );
      expect(links.map((row) => row.phone)).toEqual([newPhone]);
      const [fresh] = await queryTenant<{ must_change_password: boolean }>(
        `SELECT must_change_password FROM ${tenantTable('parents')} WHERE phone = $1`, [newPhone]
      );
      expect(fresh?.must_change_password).toBe(true);
    } finally {
      await queryTenant(`DELETE FROM ${tenantTable('students')} WHERE last_name = $1`, [`Primary-${suffix}`]);
    }
  });
});
