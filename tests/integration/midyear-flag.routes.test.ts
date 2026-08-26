import { beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getSeedContext, queryPublic, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('mid-year onboarding flag (8a)', () => {
  let tenantId = '';
  let adminHeaders: Record<string, string> = {};

  beforeAll(async () => {
    const rows = await queryPublic<IdRow>(
      `INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
       VALUES ($1, $2, $3, 'pro', 'active', 50, true)
       ON CONFLICT (schema_name) DO UPDATE SET updated_at = NOW()
       RETURNING id::text`,
      [`Midyear School ${suffix}`, `midyear-${suffix}`, TEST_SCHEMA_NAME]
    );
    tenantId = rows[0]!.id;
    const token = await signAccessToken({
      sub: getSeedContext().directorUserId,
      role: 'super_admin',
      schemaName: TEST_SCHEMA_NAME,
      tenantId,
    });
    adminHeaders = { authorization: `Bearer ${token}` };
  });

  it('active le flag puis expose midYearOnboarding dans les détails école', async () => {
    const enable = await request()
      .patch(`/api/v1/admin/schools/${tenantId}/mid-year-flag`)
      .set(adminHeaders)
      .send({ enabled: true });
    expect(enable.status, JSON.stringify(enable.body)).toBe(200);

    const details = await request()
      .get(`/api/v1/admin/schools/${tenantId}`)
      .set(adminHeaders);
    expect(details.status).toBe(200);
    expect(details.body.metadata.midYearOnboarding).toBe(true);
  });

  it('refuse un directeur d\u2019école sur cette action super admin', async () => {
    const token = await signAccessToken({
      sub: getSeedContext().directorUserId,
      role: 'director',
      schemaName: TEST_SCHEMA_NAME,
      tenantId,
    });
    const response = await request()
      .patch(`/api/v1/admin/schools/${tenantId}/mid-year-flag`)
      .set('authorization', `Bearer ${token}`)
      .send({ enabled: false });
    expect(response.status).toBe(403);
  });
});
