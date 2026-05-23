import argon2 from 'argon2';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  getSeedContext,
  queryPublic,
  queryTenant,
  request,
  tenantTable,
  TEST_SCHEMA_NAME,
} from './setup.js';

type TenantRow = { id: string };
type IdRow = { id: string };

const parentPhone = '2250709991111';
const parentPassword = '1111';
const week = '2026-W18';
const mondayDate = '2026-04-27';

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

    const studentRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, parent_phone, is_active)
        VALUES
          ($1::uuid, 'Linked', 'Student', '2250700000001', true),
          ($1::uuid, 'Other', 'Student', '2250700000002', true)
        RETURNING id::text
      `,
      [classId]
    );
    linkedStudentId = studentRows[0]!.id;
    otherStudentId = studentRows[1]!.id;

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

    await queryTenant(
      `
        INSERT INTO ${tenantTable('parent_student_links')} (subscription_id, parent_id, student_id)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `,
      [subscriptionId, parentId, linkedStudentId]
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
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          (SELECT id FROM ${tenantTable('rooms')} LIMIT 1),
          $4::uuid,
          1,
          'Mathematiques',
          true
        )
      `,
      [periodId, context.teacherId, classId, slotId]
    );

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

  it('POST /auth/login/parent avec souscription expirée → 403 + message FR', async () => {
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

    const response = await request()
      .post('/api/v1/auth/login/parent')
      .set('x-tenant-schema', TEST_SCHEMA_NAME)
      .send({ phone: expiredPhone, password: '2222' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SUBSCRIPTION_EXPIRED');
    expect(response.body.message).toContain('abonnement a expiré');
  });

  it('POST /auth/login/parent feature désactivée → 403 SERVICE_NOT_AVAILABLE', async () => {
    await queryPublic(
      `UPDATE public.school_sms_features SET is_enabled = false WHERE tenant_id = (SELECT id FROM public.tenants WHERE schema_name = $1 LIMIT 1)`,
      [TEST_SCHEMA_NAME]
    );

    const response = await loginParent();
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SERVICE_NOT_AVAILABLE');

    await queryPublic(
      `UPDATE public.school_sms_features SET is_enabled = true WHERE tenant_id = (SELECT id FROM public.tenants WHERE schema_name = $1 LIMIT 1)`,
      [TEST_SCHEMA_NAME]
    );
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

  it('GET /parent/subscription/status retourne les données attendues', async () => {
    const loginResponse = await loginParent();
    const token = loginResponse.body.accessToken;

    const response = await request()
      .get('/api/v1/parent/subscription/status')
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBeTruthy();
    expect(response.body.ends_at).toBeTruthy();
    expect(typeof response.body.days_remaining).toBe('number');
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
});
