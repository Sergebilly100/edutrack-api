import { beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getSeedContext, queryPublic, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

type TenantRow = { id: string };

describe('admin sms-feature integration', () => {
  let tenantId = '';
  let adminToken = '';

  beforeAll(async () => {
    const tenantRows = await queryPublic<TenantRow>(
      `
        INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
        VALUES ($1, $2, $3, 'pro', 'active', 50, true)
        ON CONFLICT (schema_name)
        DO UPDATE SET updated_at = NOW()
        RETURNING id::text
      `,
      ['A4 Integration School', `a4-${Date.now()}`, TEST_SCHEMA_NAME]
    );
    tenantId = tenantRows[0]!.id;

    adminToken = await signAccessToken({
      sub: getSeedContext().directorUserId,
      role: 'super_admin',
      schemaName: TEST_SCHEMA_NAME,
      tenantId,
    });
  });

  it('POST activate → school_sms_features créé avec is_enabled=true', async () => {
    const response = await request()
      .post(`/api/v1/admin/schools/${tenantId}/sms-feature/activate`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ commission_pct: 15 });

    expect(response.status).toBe(200);
    expect(response.body.is_enabled).toBe(true);

    const rows = await queryPublic<{ is_enabled: boolean }>(
      `SELECT is_enabled FROM public.school_sms_features WHERE tenant_id = $1::uuid LIMIT 1`,
      [tenantId]
    );
    expect(rows[0]?.is_enabled).toBe(true);
  });

  it('POST deactivate → is_enabled=false, souscriptions intactes', async () => {
    const context = getSeedContext();
    const parent = await queryTenant<{ id: string }>(
      `INSERT INTO ${tenantTable('parents')} (full_name, phone, password_hash, is_active) VALUES ('A4 Parent', '2250707777777', 'hash', true) RETURNING id::text`
    );
    await queryTenant(
      `
        INSERT INTO ${tenantTable('parent_subscriptions')} (
          parent_id, unit_price_fcfa, student_count, total_amount_fcfa, duration_months, starts_at, ends_at, status, created_by
        ) VALUES ($1::uuid, 1000, 1, 1000, 1, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 day', 'active', $2::uuid)
      `,
      [parent[0]!.id, context.directorUserId]
    );

    const before = await queryTenant<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${tenantTable('parent_subscriptions')}`);

    const response = await request()
      .post(`/api/v1/admin/schools/${tenantId}/sms-feature/deactivate`)
      .set('authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.is_enabled).toBe(false);

    const after = await queryTenant<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${tenantTable('parent_subscriptions')}`);
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('GET stats retourne les bonnes valeurs depuis le seed', async () => {
    const response = await request()
      .get(`/api/v1/admin/schools/${tenantId}/sms-feature/stats`)
      .set('authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('config');
    expect(response.body).toHaveProperty('current_month');
    expect(response.body).toHaveProperty('history');
    expect(response.body).toHaveProperty('sms_sent_this_month');
  });

  it('POST record-commission-received met à jour commission_paid_fcfa', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const key = '11111111-1111-4111-8111-111111111111';

    await request()
      .post(`/api/v1/admin/schools/${tenantId}/sms-feature/sync-commission?month=${month}`)
      .set('authorization', `Bearer ${adminToken}`);

    const response = await request()
      .post(`/api/v1/admin/schools/${tenantId}/sms-feature/record-commission-received`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period_month: month, amount_fcfa: 1000, notes: 'a4 test', idempotency_key: key });

    expect(response.status).toBe(200);
    expect(response.body.commission_paid_fcfa).toBeGreaterThanOrEqual(1000);

    const replay = await request()
      .post(`/api/v1/admin/schools/${tenantId}/sms-feature/record-commission-received`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period_month: month, amount_fcfa: 1000, notes: 'a4 test replay', idempotency_key: key });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotency_replayed).toBe(true);

    const stats = await request()
      .get(`/api/v1/admin/schools/${tenantId}/sms-feature/stats`)
      .set('authorization', `Bearer ${adminToken}`);
    expect(stats.status).toBe(200);
    expect(stats.body.current_month.commission_paid_fcfa).toBeGreaterThanOrEqual(1000);

    const auditRows = await queryPublic<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM public.audit_financial_events
       WHERE tenant_id = $1::uuid
         AND action IN ('admin.sync_commission', 'admin.record_commission_received')`,
      [tenantId]
    );
    expect(auditRows[0]?.count).toBeGreaterThanOrEqual(2);
  });

  it('GET global-stats liste les écoles avec feature activée', async () => {
    await request()
      .post(`/api/v1/admin/schools/${tenantId}/sms-feature/activate`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ commission_pct: 12 });

    const response = await request()
      .get('/api/v1/admin/sms-feature/global-stats')
      .set('authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
    expect(response.body.items.some((item: { tenant_id: string }) => item.tenant_id === tenantId)).toBe(true);
  }, 15000);

  it('GET commission-payments retourne les reversements admin.record_commission_received', async () => {
    const month = new Date().toISOString().slice(0, 7);

    // On s'assure qu'un reversement admin existe pour ce mois
    await request()
      .post(`/api/v1/admin/schools/${tenantId}/sms-feature/sync-commission?month=${month}`)
      .set('authorization', `Bearer ${adminToken}`);
    await request()
      .post(`/api/v1/admin/schools/${tenantId}/sms-feature/record-commission-received`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        period_month: month,
        amount_fcfa: 500,
        notes: 'test admin payment',
        idempotency_key: '22222222-2222-4222-8222-222222222222',
      });

    const response = await request()
      .get(`/api/v1/admin/schools/${tenantId}/sms-feature/payments?month=${month}`)
      .set('authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
    const entry = (response.body.items as Array<{ amount_fcfa: number; notes: string | null }>)
      .find((r) => r.notes === 'test admin payment');
    expect(entry).toBeDefined();
    expect(entry?.amount_fcfa).toBe(500);
  });

  it('GET commission-payments remonte aussi les reversements subscriptions.record_commission_payment', async () => {
    const month = new Date().toISOString().slice(0, 7);

    // Insère directement un audit event avec action=subscriptions.record_commission_payment
    // pour simuler un reversement enregistré côté directeur école
    await queryPublic(
      `
        INSERT INTO public.audit_financial_events
          (tenant_id, actor_id, actor_role, action, idempotency_key, payload_before, payload_after)
        VALUES (
          $1::uuid,
          $2::uuid,
          'director',
          'subscriptions.record_commission_payment',
          '33333333-3333-4333-8333-333333333333'::uuid,
          '{"commission_paid_fcfa": 0}'::jsonb,
          jsonb_build_object(
            'period_month', $3::text,
            'amount_fcfa', 300,
            'payment_method', 'momo_mtn',
            'notes', 'reversement directeur'
          )
        )
        ON CONFLICT (action, tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      `,
      [tenantId, getSeedContext().directorUserId, `${month}-01`]
    );

    const response = await request()
      .get(`/api/v1/admin/schools/${tenantId}/sms-feature/payments?month=${month}`)
      .set('authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
    const entry = (response.body.items as Array<{ amount_fcfa: number; notes: string | null }>)
      .find((r) => r.notes === 'reversement directeur');
    expect(entry).toBeDefined();
    expect(entry?.amount_fcfa).toBe(300);
  });

  it('GET commission-payments utilise le fallback edutrack_commission_records si aucun audit event', async () => {
    const fallbackMonth = '2024-03';

    // Insère un enregistrement dans edutrack_commission_records sans événement audit correspondant
    await queryPublic(
      `
        INSERT INTO public.edutrack_commission_records
          (tenant_id, period_month, commission_due_fcfa, commission_paid_fcfa, commission_pct)
        VALUES ($1::uuid, $2::date, 45, 45, 15.00)
        ON CONFLICT (tenant_id, period_month) DO UPDATE
          SET commission_paid_fcfa = 45
      `,
      [tenantId, `${fallbackMonth}-01`]
    );

    const response = await request()
      .get(`/api/v1/admin/schools/${tenantId}/sms-feature/payments?month=${fallbackMonth}`)
      .set('authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
    const entries = response.body.items as Array<{ amount_fcfa: number; notes: string | null; id: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount_fcfa).toBe(45);
    expect(entries[0]?.notes).toContain('Historique importé');
    expect(entries[0]?.id).toMatch(/^fallback-/);
  });
});
