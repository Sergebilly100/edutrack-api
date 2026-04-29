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

type TenantRow = { id: string };
type StudentRow = { id: string };
type AssignmentRow = { id: string };

describe('subscriptions integration (real db)', () => {
  let tenantId = '';
  let studentIds: string[] = [];
  let assignmentId: string | null = null;
  let createdParentId = '';
  let createdParentPhone = '';

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
      ['Integration School', `integration-${Date.now()}`, TEST_SCHEMA_NAME]
    );
    tenantId = tenantRows[0]!.id;

    await queryPublic(
      `
        INSERT INTO public.school_sms_features (tenant_id, is_enabled, commission_pct, sms_cap_per_student, sms_unit_price_fcfa)
        VALUES ($1::uuid, false, 15.00, 60, NULL)
        ON CONFLICT (tenant_id)
        DO UPDATE SET is_enabled = EXCLUDED.is_enabled, sms_unit_price_fcfa = EXCLUDED.sms_unit_price_fcfa
      `,
      [tenantId]
    );

    const studentRows = await queryTenant<StudentRow>(
      `
        INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, parent_phone, is_active)
        VALUES
        ((SELECT id FROM ${tenantTable('classes')} LIMIT 1), 'Parent', 'Student One', '2250700001111', true),
        ((SELECT id FROM ${tenantTable('classes')} LIMIT 1), 'Parent', 'Student Two', '2250700002222', true)
        RETURNING id::text
      `
    );
    studentIds = studentRows.map((item) => item.id);

    const assignmentRows = await queryTenant<AssignmentRow>(
      `
        WITH pos AS (
          INSERT INTO ${tenantTable('admin_positions')} (name, permissions, created_by)
          VALUES ('Subs Viewer', '["subscriptions.view"]'::jsonb, $1::uuid)
          RETURNING id
        )
        INSERT INTO ${tenantTable('position_assignments')} (user_id, position_id, assigned_by)
        SELECT $2::uuid, pos.id, $1::uuid
        FROM pos
        RETURNING id::text
      `,
      [context.directorUserId, context.staffUserId]
    );
    assignmentId = assignmentRows[0]?.id ?? null;
  });

  it('POST /api/v1/subscriptions/parents sans feature activée → 422', async () => {
    const headers = await getAuthHeaders('director');
    const response = await request()
      .post('/api/v1/subscriptions/parents')
      .set(headers)
      .send({
        full_name: 'Test Parent',
        phone: '2250709990000',
        student_ids: [studentIds[0]],
        duration_months: 1,
        payment_method: 'cash',
        paid_now: true,
      });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'SMS_FEATURE_NOT_ENABLED',
    });
  });

  it('POST /api/v1/subscriptions/parents avec feature activée → 201 + credentials', async () => {
    await queryPublic(
      `
        UPDATE public.school_sms_features
        SET is_enabled = true,
            sms_unit_price_fcfa = 1000,
            activated_at = NOW()
        WHERE tenant_id = $1::uuid
      `,
      [tenantId]
    );

    const headers = await getAuthHeaders('director');
    const response = await request()
      .post('/api/v1/subscriptions/parents')
      .set(headers)
      .send({
        full_name: 'Test Parent Enabled',
        phone: '2250709990001',
        email: 'parent.enabled@test.ci',
        student_ids: studentIds,
        duration_months: 2,
        payment_method: 'momo_mtn',
        paid_now: true,
      });

    expect(response.status).toBe(201);
    expect(response.body.parent?.id).toBeTruthy();
    expect(response.body.subscription?.id).toBeTruthy();
    expect(typeof response.body.credentials?.temp_password).toBe('string');
    expect(response.body.credentials?.temp_password.length).toBe(4);
    createdParentId = response.body.parent.id;
    createdParentPhone = response.body.parent.phone;
  });

  it('POST /api/v1/subscriptions/parents sans tarif configuré → 422 SMS_PRICE_NOT_CONFIGURED', async () => {
    await queryPublic(
      `
        UPDATE public.school_sms_features
        SET is_enabled = true,
            sms_unit_price_fcfa = NULL
        WHERE tenant_id = $1::uuid
      `,
      [tenantId]
    );

    const headers = await getAuthHeaders('director');
    const response = await request()
      .post('/api/v1/subscriptions/parents')
      .set(headers)
      .send({
        full_name: 'No Price Parent',
        phone: '2250709990009',
        student_ids: [studentIds[0]],
        duration_months: 1,
        payment_method: 'cash',
        paid_now: true,
      });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('SMS_PRICE_NOT_CONFIGURED');

    await queryPublic(
      `
        UPDATE public.school_sms_features
        SET sms_unit_price_fcfa = 1000
        WHERE tenant_id = $1::uuid
      `,
      [tenantId]
    );
  });

  it('POST /api/v1/subscriptions/parents (phone déjà existant) → 409', async () => {
    const headers = await getAuthHeaders('director');
    const response = await request()
      .post('/api/v1/subscriptions/parents')
      .set(headers)
      .send({
        full_name: 'Duplicate Parent',
        phone: createdParentPhone,
        student_ids: [studentIds[0]],
        duration_months: 1,
        payment_method: 'cash',
        paid_now: true,
      });

    expect(response.status).toBe(409);
  });

  it('POST /api/v1/subscriptions/parents/:id/renew crée une nouvelle souscription', async () => {
    const headers = await getAuthHeaders('director');
    const previous = await queryTenant<{ ends_at: string }>(
      `
        SELECT ends_at::text
        FROM ${tenantTable('parent_subscriptions')}
        WHERE parent_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [createdParentId]
    );

    const response = await request()
      .post(`/api/v1/subscriptions/parents/${createdParentId}/renew`)
      .set(headers)
      .send({
        duration_months: 1,
        payment_method: 'cash',
        paid_now: true,
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeTruthy();

    const startsAt = response.body.starts_at as string;
    const expectedStart = new Date(`${previous[0]!.ends_at}T00:00:00.000Z`);
    expectedStart.setUTCDate(expectedStart.getUTCDate() + 1);
    expect(startsAt).toBe(expectedStart.toISOString().slice(0, 10));
  });

  it('PATCH cancel met la souscription à cancelled', async () => {
    const headers = await getAuthHeaders('director');
    const latest = await queryTenant<{ id: string }>(
      `
        SELECT id::text
        FROM ${tenantTable('parent_subscriptions')}
        WHERE parent_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [createdParentId]
    );

    const subscriptionId = latest[0]!.id;
    const response = await request()
      .patch(`/api/v1/subscriptions/parents/${createdParentId}/subscription/${subscriptionId}/cancel`)
      .set(headers)
      .send({});

    expect(response.status).toBe(200);

    const state = await queryTenant<{ status: string }>(
      `SELECT status::text FROM ${tenantTable('parent_subscriptions')} WHERE id = $1::uuid`,
      [subscriptionId]
    );
    expect(state[0]!.status).toBe('cancelled');
  });

  it('POST reset-password retourne un nouveau mot de passe temporaire', async () => {
    const headers = await getAuthHeaders('director');
    const response = await request()
      .post(`/api/v1/subscriptions/parents/${createdParentId}/reset-password`)
      .set(headers)
      .send({});

    expect(response.status).toBe(200);
    expect(typeof response.body.new_temp_password).toBe('string');
    expect(response.body.new_temp_password.length).toBe(4);

    const state = await queryTenant<{ must_change_password: boolean }>(
      `SELECT must_change_password FROM ${tenantTable('parents')} WHERE id = $1::uuid`,
      [createdParentId]
    );
    expect(state[0]?.must_change_password).toBe(true);
  });

  it('GET /api/v1/subscriptions/revenue/summary retourne les agrégats', async () => {
    const headers = await getAuthHeaders('director');
    const response = await request()
      .get('/api/v1/subscriptions/revenue/summary')
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('commission_due_fcfa');
    expect(response.body).toHaveProperty('total_collected_fcfa');
  });

  it('POST /api/v1/subscriptions/revenue/commission/record-payment est idempotent avec idempotency_key', async () => {
    const headers = await getAuthHeaders('director');
    const month = new Date().toISOString().slice(0, 7);
    const idempotencyKey = '22222222-2222-4222-8222-222222222222';

    const first = await request()
      .post('/api/v1/subscriptions/revenue/commission/record-payment')
      .set(headers)
      .send({
        period_month: month,
        amount_fcfa: 500,
        notes: 'idempotency test',
        idempotency_key: idempotencyKey,
      });
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);
    expect(first.body.idempotency_replayed).toBe(false);

    const second = await request()
      .post('/api/v1/subscriptions/revenue/commission/record-payment')
      .set(headers)
      .send({
        period_month: month,
        amount_fcfa: 500,
        notes: 'idempotency test replay',
        idempotency_key: idempotencyKey,
      });
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
    expect(second.body.idempotency_replayed).toBe(true);

    const paidRows = await queryPublic<{ commission_paid_fcfa: number }>(
      `
        SELECT commission_paid_fcfa
        FROM public.edutrack_commission_records
        WHERE tenant_id = $1::uuid
          AND period_month = ($2 || '-01')::date
        LIMIT 1
      `,
      [tenantId, month]
    );
    expect((paidRows[0]?.commission_paid_fcfa ?? 0) >= 500).toBe(true);

    const auditRows = await queryPublic<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM public.audit_financial_events
        WHERE tenant_id = $1::uuid
          AND action = 'subscriptions.record_commission_payment'
      `,
      [tenantId]
    );
    expect((auditRows[0]?.count ?? 0) >= 1).toBe(true);
  });

  it('Compte staff avec subscriptions.view → GET /parents → 200', async () => {
    const headers = await getAuthHeaders('staff');
    const response = await request()
      .get('/api/v1/subscriptions/parents')
      .set(headers);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it('Compte staff sans poste assigné conserve la base subscriptions.* → GET /parents → 200', async () => {
    if (assignmentId) {
      await queryTenant(
        `DELETE FROM ${tenantTable('position_assignments')} WHERE id = $1::uuid`,
        [assignmentId]
      );
    }

    const headers = await getAuthHeaders('staff');
    const response = await request()
      .get('/api/v1/subscriptions/parents')
      .set(headers);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
  });
});
