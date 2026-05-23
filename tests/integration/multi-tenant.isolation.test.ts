import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../../src/modules/auth/auth.service.js';
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
type IdRow = { id: string };
type CountRow = { count: number };

const IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]*$/;

const quoteIdentifier = (identifier: string): string => {
  if (!IDENTIFIER_REGEX.test(identifier)) {
    throw new Error(`[integration] Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

const tenantTableForSchema = (schemaName: string, tableName: string): string => {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
};

describe('multi-tenant isolation hardening', () => {
  let tenantAId = '';
  let tenantBId = '';
  let tenantBSchema = '';

  let parentAToken = '';
  let parentAStudentId = '';
  let parentBStudentId = '';
  let parentBId = '';

  let adminToken = '';

  beforeAll(async () => {
    const context = getSeedContext();

    const tenantA = await queryPublic<TenantRow>(
      `
        INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
        VALUES ($1, $2, $3, 'pro', 'active', 50, true)
        ON CONFLICT (schema_name)
        DO UPDATE SET updated_at = NOW()
        RETURNING id::text
      `,
      ['D6 Tenant A', `d6-a-${Date.now()}`, TEST_SCHEMA_NAME]
    );
    tenantAId = tenantA[0]!.id;

    tenantBSchema = `school_d6_${randomBytes(3).toString('hex')}`;
    const { createTenantSchema } = await import('../../src/shared/database/tenant-init.js');
    await createTenantSchema(tenantBSchema);

    const tenantB = await queryPublic<TenantRow>(
        `
          INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
          VALUES ($1, $2, $3, 'pro', 'active', 50, true)
          RETURNING id::text
        `,
        ['D6 Tenant B', `d6-b-${Date.now()}`, tenantBSchema]
      );
      tenantBId = tenantB[0]!.id;

      await queryPublic(
        `
          INSERT INTO public.school_sms_features (tenant_id, is_enabled, commission_pct, sms_cap_per_student, sms_unit_price_fcfa, monetize_parent_alerts)
          VALUES ($1::uuid, true, 12.00, 60, 1000, true)
          ON CONFLICT (tenant_id)
          DO UPDATE SET
            is_enabled = true,
            commission_pct = EXCLUDED.commission_pct,
            sms_unit_price_fcfa = EXCLUDED.sms_unit_price_fcfa,
            monetize_parent_alerts = EXCLUDED.monetize_parent_alerts
        `,
        [tenantAId]
      );

      await queryPublic(
        `
          INSERT INTO public.school_sms_features (tenant_id, is_enabled, commission_pct, sms_cap_per_student, sms_unit_price_fcfa, monetize_parent_alerts)
          VALUES ($1::uuid, true, 18.00, 60, 1200, true)
          ON CONFLICT (tenant_id)
          DO UPDATE SET
            is_enabled = true,
            commission_pct = EXCLUDED.commission_pct,
            sms_unit_price_fcfa = EXCLUDED.sms_unit_price_fcfa,
            monetize_parent_alerts = EXCLUDED.monetize_parent_alerts
        `,
        [tenantBId]
      );

      const tenantBDirector = await queryPublic<IdRow>(
        `
          INSERT INTO ${tenantTableForSchema(tenantBSchema, 'users')} (role, name, phone, email, password_hash, is_active)
          VALUES ('director', 'Director B', '2250706220099', 'director-b@d6.ci', 'hash', true)
          RETURNING id::text AS id
        `
      );

      const tenantBClass = await queryPublic<IdRow>(
        `
          INSERT INTO ${tenantTableForSchema(tenantBSchema, 'classes')} (name, level, student_count)
          VALUES ('D6 B Class', '3eme', 0)
          RETURNING id::text AS id
        `
      );

      const classA = await queryTenant<IdRow>(`SELECT id::text AS id FROM ${tenantTable('classes')} LIMIT 1`);
      const classAId = classA[0]!.id;

      const studentA = await queryTenant<IdRow>(
        `
          INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, parent_phone, is_active)
          VALUES ($1::uuid, 'Tenant', 'AStudent', '2250706110001', true)
          RETURNING id::text AS id
        `,
        [classAId]
      );
      parentAStudentId = studentA[0]!.id;

      const parentAPassword = '1111';
      const parentAHash = await argon2.hash(parentAPassword);
      const parentA = await queryTenant<IdRow>(
        `
          INSERT INTO ${tenantTable('parents')} (full_name, phone, email, password_hash, must_change_password, is_active)
          VALUES ('Parent A', '2250706110000', 'parent-a@d6.ci', $1, false, true)
          RETURNING id::text AS id
        `,
        [parentAHash]
      );
      const parentAId = parentA[0]!.id;

      const subA = await queryTenant<IdRow>(
        `
          INSERT INTO ${tenantTable('parent_subscriptions')} (
            parent_id, unit_price_fcfa, student_count, total_amount_fcfa, duration_months,
            starts_at, ends_at, status, created_by
          )
          VALUES ($1::uuid, 1000, 1, 1000, 1, CURRENT_DATE - INTERVAL '1 day', CURRENT_DATE + INTERVAL '29 day', 'active', $2::uuid)
          RETURNING id::text AS id
        `,
        [parentAId, context.directorUserId]
      );

      await queryTenant(
        `
          INSERT INTO ${tenantTable('parent_student_links')} (subscription_id, parent_id, student_id)
          VALUES ($1::uuid, $2::uuid, $3::uuid)
        `,
        [subA[0]!.id, parentAId, parentAStudentId]
      );

      const studentBRows = await queryPublic<IdRow>(
        `
          INSERT INTO ${tenantTableForSchema(tenantBSchema, 'students')} (class_id, first_name, last_name, parent_phone, is_active)
          VALUES (
            $1::uuid,
            'Tenant', 'BStudent', '2250706220001', true
          )
          RETURNING id::text AS id
        `,
        [tenantBClass[0]!.id]
      );
      parentBStudentId = studentBRows[0]!.id;

      const parentBHash = await argon2.hash('2222');
      const parentBRows = await queryPublic<IdRow>(
        `
          INSERT INTO ${tenantTableForSchema(tenantBSchema, 'parents')} (full_name, phone, email, password_hash, must_change_password, is_active)
          VALUES ('Parent B', '2250706220000', 'parent-b@d6.ci', $1, false, true)
          RETURNING id::text AS id
        `,
        [parentBHash]
      );
      parentBId = parentBRows[0]!.id;

      const subBRows = await queryPublic<IdRow>(
        `
          INSERT INTO ${tenantTableForSchema(tenantBSchema, 'parent_subscriptions')} (
            parent_id, unit_price_fcfa, student_count, total_amount_fcfa, duration_months,
            starts_at, ends_at, status, created_by
          )
          VALUES (
            $1::uuid,
            1200,
            1,
            1200,
            1,
            CURRENT_DATE - INTERVAL '2 day',
            CURRENT_DATE + INTERVAL '28 day',
            'active',
            $2::uuid
          )
          RETURNING id::text AS id
        `,
        [parentBId, tenantBDirector[0]!.id]
      );

      await queryPublic(
        `
          INSERT INTO ${tenantTableForSchema(tenantBSchema, 'parent_student_links')} (subscription_id, parent_id, student_id)
          VALUES ($1::uuid, $2::uuid, $3::uuid)
        `,
        [subBRows[0]!.id, parentBId, parentBStudentId]
      );

      const parentALogin = await request()
        .post('/api/v1/auth/login/parent')
        .set('x-tenant-schema', TEST_SCHEMA_NAME)
        .send({ phone: '2250706110000', password: parentAPassword });

      expect(parentALogin.status).toBe(200);
      parentAToken = parentALogin.body.accessToken;

    adminToken = await signAccessToken({
      sub: context.directorUserId,
      role: 'super_admin',
      schemaName: TEST_SCHEMA_NAME,
      tenantId: tenantAId,
    });
  });

  afterAll(async () => {
    if (tenantBSchema) {
      await queryPublic(`DROP SCHEMA IF EXISTS ${quoteIdentifier(tenantBSchema)} CASCADE`);
    }
  });

  it('Parent tenant A avec JWT valide ne peut pas accéder à studentId tenant B (403)', async () => {
    const response = await request()
      .get(`/api/v1/parent/students/${parentBStudentId}/stats`)
      .set('authorization', `Bearer ${parentAToken}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('STUDENT_ACCESS_DENIED');
  });

  it('Staff tenant A ne peut pas ouvrir parentId tenant B (404 sans fuite)', async () => {
    const headers = await getAuthHeaders('staff');

    const response = await request()
      .get(`/api/v1/subscriptions/parents/${parentBId}`)
      .set(headers);

    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain('Parent B');
    expect(JSON.stringify(response.body)).not.toContain('2250706220000');
  });

  it('Sync commission tenant A n’impacte jamais tenant B', async () => {
    const month = new Date().toISOString().slice(0, 7);

    const beforeB = await queryPublic<CountRow>(
      `SELECT COUNT(*)::int AS count FROM public.edutrack_commission_records WHERE tenant_id = $1::uuid`,
      [tenantBId]
    );

    const response = await request()
      .post(`/api/v1/admin/schools/${tenantAId}/sms-feature/sync-commission?month=${month}`)
      .set('authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);

    const afterB = await queryPublic<CountRow>(
      `SELECT COUNT(*)::int AS count FROM public.edutrack_commission_records WHERE tenant_id = $1::uuid`,
      [tenantBId]
    );

    expect(afterB[0]!.count).toBe(beforeB[0]!.count);
  });

  it('Dashboard parent A ne retourne aucune donnée tenant B', async () => {
    const response = await request()
      .get('/api/v1/parent/students')
      .set('authorization', `Bearer ${parentAToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data.every((student: { id: string }) => student.id !== parentBStudentId)).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('BStudent');
  });
});
