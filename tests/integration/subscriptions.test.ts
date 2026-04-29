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
    expect(response.body.credentials?.temp_password).toBe('0001');
  });

  it('Compte staff avec subscriptions.view → GET /parents → 200', async () => {
    const headers = await getAuthHeaders('staff');
    const response = await request()
      .get('/api/v1/subscriptions/parents')
      .set(headers);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it('Compte staff sans permission → GET /parents → 403', async () => {
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

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
