import { beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getSeedContext, queryPublic, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

type TenantRow = { id: string };

const suffix = String(Date.now());

describe('admin school-year routes (super admin)', () => {
  let tenantId = '';
  let adminHeaders: Record<string, string> = {};

  const resetActiveYears = async (): Promise<string> => {
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status = 'closed' WHERE status = 'active'`);
    const years = await queryTenant<{ id: string; label: string }>(
      `
        INSERT INTO ${tenantTable('school_years')}
          (label, start_date, end_date, end_of_year_review_start_date, status)
        VALUES ($1, '2090-09-01', '2091-06-30', '2091-05-01', 'active')
        ON CONFLICT (label) DO UPDATE
          SET status = 'active',
              start_date = EXCLUDED.start_date,
              end_date = EXCLUDED.end_date,
              end_of_year_review_start_date = EXCLUDED.end_of_year_review_start_date,
              updated_at = NOW()
        RETURNING id::text, label
      `,
      [`baseline-${suffix}`]
    );
    return years[0]!.label;
  };

  beforeAll(async () => {
    const tenantRows = await queryPublic<TenantRow>(
      `
        INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
        VALUES ($1, $2, $3, 'pro', 'active', 50, true)
        ON CONFLICT (schema_name)
        DO UPDATE SET updated_at = NOW()
        RETURNING id::text
      `,
      ['School Year Integration School', `schoolyear-${suffix}`, TEST_SCHEMA_NAME]
    );
    tenantId = tenantRows[0]!.id;

    const token = await signAccessToken({
      sub: getSeedContext().directorUserId,
      role: 'super_admin',
      schemaName: TEST_SCHEMA_NAME,
      tenantId,
    });
    adminHeaders = { authorization: `Bearer ${token}` };
  });

  it('ouvre une nouvelle année : l\u2019ancienne passe à closed, la nouvelle devient active', async () => {
    const previousLabel = await resetActiveYears();

    const response = await request()
      .post(`/api/v1/admin/schools/${tenantId}/school-year/open`)
      .set(adminHeaders)
      .send({
        label: `open-${suffix}`,
        start_date: '2091-09-01',
        end_date: '2092-06-30',
        end_of_year_review_start_date: '2092-05-01',
        period_type: 'semester',
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      label: `open-${suffix}`,
      status: 'active',
      startDate: '2091-09-01',
      endDate: '2092-06-30',
      gradingPeriodType: 'semester',
      closedPreviousLabel: previousLabel,
    });

    const statuses = await queryTenant<{ label: string; status: string }>(
      `SELECT label, status::text FROM ${tenantTable('school_years')} WHERE label IN ($1, $2)`,
      [previousLabel, `open-${suffix}`]
    );
    expect(statuses).toContainEqual({ label: previousLabel, status: 'closed' });
    expect(statuses).toContainEqual({ label: `open-${suffix}`, status: 'active' });

    const periods = await queryTenant<{ label: string; type: string; order_index: number }>(
      `SELECT label, type::text, order_index FROM ${tenantTable('grading_periods')} WHERE school_year_id = (SELECT id FROM ${tenantTable('school_years')} WHERE label = $1) ORDER BY order_index`,
      [`open-${suffix}`]
    );
    expect(periods).toEqual([
      { label: '1er semestre', type: 'semester', order_index: 1 },
      { label: '2e semestre', type: 'semester', order_index: 2 },
    ]);

    // L'affichage "année scolaire active" du tenant est synchronisé.
    const tenantRow = await queryPublic<{ active_school_year: string }>(
      'SELECT active_school_year FROM public.tenants WHERE id = $1::uuid',
      [tenantId]
    );
    expect(tenantRow[0]?.active_school_year).toBe('09/2091 - 06/2092');
  });

  it('renvoie le statut de l\u2019année active et de la fenêtre de fin d\u2019année', async () => {
    await resetActiveYears();

    const response = await request()
      .get(`/api/v1/admin/schools/${tenantId}/school-year`)
      .set(adminHeaders);

    expect(response.status).toBe(200);
    expect(response.body.hasActiveYear).toBe(true);
    expect(response.body.activeYear).toMatchObject({ label: `baseline-${suffix}` });
    // La revue démarre en 2091 : la fenêtre n'est pas ouverte aujourd'hui.
    expect(response.body.isEndOfYearWindowOpen).toBe(false);
  });

  it('refuse un libellé déjà utilisé pour la même école', async () => {
    const previousLabel = await resetActiveYears();

    const response = await request()
      .post(`/api/v1/admin/schools/${tenantId}/school-year/open`)
      .set(adminHeaders)
      .send({
        label: previousLabel,
        start_date: '2092-09-01',
        end_date: '2093-06-30',
      });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('libellé');

    const statuses = await queryTenant<{ status: string }>(
      `SELECT status::text FROM ${tenantTable('school_years')} WHERE label = $1`,
      [previousLabel]
    );
    // L'ancienne année reste active : rien n'a été basculé.
    expect(statuses[0]?.status).toBe('active');
  });

  it('refuse des dates incohérentes (fin avant revue)', async () => {
    await resetActiveYears();

    const response = await request()
      .post(`/api/v1/admin/schools/${tenantId}/school-year/open`)
      .set(adminHeaders)
      .send({
        label: `dates-${suffix}`,
        start_date: '2092-09-01',
        end_date: '2093-06-30',
        end_of_year_review_start_date: '2093-07-15',
      });

    expect(response.status).toBe(400);
  });

  it('interdit à un directeur ou un staff de déclencher l\u2019ouverture', async () => {
    const previousLabel = await resetActiveYears();

    for (const role of ['director', 'staff'] as const) {
      const token = await signAccessToken({
        sub: role === 'director' ? getSeedContext().directorUserId : getSeedContext().staffUserId,
        role,
        schemaName: TEST_SCHEMA_NAME,
        tenantId,
      });
      const response = await request()
        .post(`/api/v1/admin/schools/${tenantId}/school-year/open`)
        .set('authorization', `Bearer ${token}`)
        .send({
          label: `forbidden-${role}-${suffix}`,
          start_date: '2092-09-01',
          end_date: '2093-06-30',
        });
      expect(response.status, `role=${role}`).toBe(403);
    }

    const created = await queryTenant<{ id: string }>(
      `SELECT id::text FROM ${tenantTable('school_years')} WHERE status = 'active' AND label <> $1`,
      [previousLabel]
    );
    expect(created).toHaveLength(0);
  });
});
