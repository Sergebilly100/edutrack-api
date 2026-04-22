import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryTenant, request, TEST_SCHEMA_NAME, tenantTable } from './setup.js';

describe('G5 users limit enforcement', () => {
  const ensureTenantRow = async (maxUsers: number) => {
    await queryTenant(
      `
        INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
        VALUES ($1, $2, $3, 'pro', 'active', $4, true)
        ON CONFLICT (schema_name)
        DO UPDATE SET
          plan = 'pro',
          status = 'active',
          max_users = EXCLUDED.max_users,
          updated_at = NOW()
      `,
      ['School Test', `test-${TEST_SCHEMA_NAME}`, TEST_SCHEMA_NAME, maxUsers]
    );
  };

  it('POST /api/v1/teachers refuse la création du 21e utilisateur sur plan pro (max=20)', async () => {
    const headers = await getAuthHeaders('director');
    await ensureTenantRow(20);

    await queryTenant(
      `
        INSERT INTO ${tenantTable('users')} (role, name, phone, email, password_hash, is_active)
        SELECT
          'staff',
          'Quota User ' || gs,
          NULL,
          'quota' || gs || '@test.local',
          'not-used',
          true
        FROM generate_series(1, 17) AS gs
      `,
      []
    );

    const response = await request()
      .post('/api/v1/teachers')
      .set(headers)
      .send({
        first_name: 'Nouveau',
        last_name: 'Prof',
        type: 'vacataire',
        subjects: ['Maths'],
        hourly_rate: 4000,
      });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'USERS_LIMIT_REACHED',
      statusCode: 403,
    });
  });

  it('POST /api/v1/permissions/positions/:id/assign refuse un utilisateur non administratif', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    await ensureTenantRow(3);

    await queryTenant(
      `
        UPDATE public.tenants
        SET max_users = 3
        WHERE schema_name = $1
      `,
      [TEST_SCHEMA_NAME]
    );

    const createdPositionRows = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('admin_positions')} (name, permissions, created_by)
        VALUES ($1, $2::jsonb, $3)
        RETURNING id
      `,
      ['Assistant pédagogique', JSON.stringify(['teachers.view']), context.directorUserId]
    );
    const positionId = createdPositionRows[0]?.id;
    if (!positionId) {
      throw new Error('Failed to create test position');
    }

    const response = await request()
      .post(`/api/v1/permissions/positions/${positionId}/assign`)
      .set(headers)
      .send({
        userId: context.teacherUserId,
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'INVALID_ASSIGNMENT_TARGET',
      statusCode: 400,
    });
  });
});
