import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
type SubRow = { id: string };

describe('subscriptions - isolation inter-tenant', () => {
  let tenantId = '';
  let parentId = '';
  let subscriptionId = '';

  beforeAll(async () => {
    const context = getSeedContext();

    const tenantRows = await queryPublic<TenantRow>(
      `
        INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
        VALUES ($1, $2, $3, 'pro', 'active', 50, true)
        ON CONFLICT (schema_name) DO UPDATE SET updated_at = NOW()
        RETURNING id::text
      `,
      ['Isolation School', `isolation-subs-${Date.now()}`, TEST_SCHEMA_NAME]
    );
    tenantId = tenantRows[0]!.id;

    await queryPublic(
      `
        INSERT INTO public.school_sms_features (tenant_id, is_enabled, commission_pct, sms_cap_per_student, sms_unit_price_fcfa, monetize_parent_alerts)
        VALUES ($1::uuid, true, 15.00, 60, 1000, true)
        ON CONFLICT (tenant_id) DO UPDATE SET
          is_enabled = true,
          sms_unit_price_fcfa = 1000,
          monetize_parent_alerts = true
      `,
      [tenantId]
    );

    const studentRows = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, parent_phone, is_active)
        VALUES ((SELECT id FROM ${tenantTable('classes')} LIMIT 1), 'Isolation', 'Student', '2250701234560', true)
        RETURNING id::text
      `
    );
    const studentId = studentRows[0]!.id;

    const parentRows = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('parents')} (full_name, phone, password_hash, must_change_password, is_active)
        VALUES ('Isolation Parent', '2250701234561', 'hash', false, true)
        RETURNING id::text
      `
    );
    parentId = parentRows[0]!.id;

    const subRows = await queryTenant<SubRow>(
      `
        INSERT INTO ${tenantTable('parent_subscriptions')} (
          parent_id, unit_price_fcfa, student_count, total_amount_fcfa, duration_months,
          starts_at, ends_at, status, auto_renew_alert, renewed_count, created_by
        ) VALUES ($1::uuid, 1000, 1, 1000, 1, CURRENT_DATE, CURRENT_DATE + 30, 'active', false, 0, $2::uuid)
        RETURNING id::text
      `,
      [parentId, context.directorUserId]
    );
    subscriptionId = subRows[0]!.id;

    void studentId;
  });

  it('GET revenue/subscriptions ne retourne que les données du tenant courant', async () => {
    const headers = await getAuthHeaders('director');
    const month = new Date().toISOString().slice(0, 7);

    const response = await request()
      .get('/api/v1/subscriptions/revenue/subscriptions')
      .set(headers)
      .query({ month });

    expect(response.status).toBe(200);
    const data = response.body.data as Array<{ parent_id: string }>;
    if (data.length > 0) {
      const parentIds = data.map((item) => item.parent_id);
      for (const pid of parentIds) {
        const found = await queryTenant<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ${tenantTable('parents')} WHERE id = $1::uuid`,
          [pid]
        );
        expect(found[0]?.count).toBe(1);
      }
    }
  });

  it('GET revenue/summary utilise le tenant du token JWT', async () => {
    const headers = await getAuthHeaders('director');
    const month = new Date().toISOString().slice(0, 7);

    const response = await request()
      .get('/api/v1/subscriptions/revenue/summary')
      .set(headers)
      .query({ month });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('commission_due_fcfa');
    expect(typeof response.body.subscriptions_active_count).toBe('number');
  });

  it('PATCH cancel avec parentId ne correspondant pas à la subscription → 403', async () => {
    const headers = await getAuthHeaders('director');

    // parentId est réel (Isolation Parent) mais ne correspond pas à subscriptionId
    // → le service doit lever SUBSCRIPTION_OWNERSHIP_MISMATCH
    const otherParentRows = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('parents')} (full_name, phone, password_hash, must_change_password, is_active)
        VALUES ('Other Parent Isolation', '2250701234562', 'hash', false, true)
        RETURNING id::text
      `
    );
    const otherParentId = otherParentRows[0]!.id;

    const response = await request()
      .patch(`/api/v1/subscriptions/parents/${otherParentId}/subscription/${subscriptionId}/cancel`)
      .set(headers)
      .send({ reason: 'Erreur de saisie' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SUBSCRIPTION_OWNERSHIP_MISMATCH');
  });

  afterAll(() => {
    void tenantId;
    void parentId;
    void subscriptionId;
  });
});
