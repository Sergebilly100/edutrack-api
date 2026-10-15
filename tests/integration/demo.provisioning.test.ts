import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { provisionDemo } from '../../src/shared/database/demo/demo.service.js';
import { DemoRepository } from '../../src/shared/database/demo/demo.repository.js';
import { runDashboardActionsForSchema } from '../../src/modules/dashboard-actions/dashboard-actions.worker.js';
import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getSeedContext, queryPublic, request, TEST_SCHEMA_NAME } from './setup.js';

const suffix = randomBytes(5).toString('hex');
const names = ['empty', 'seeded', 'rollback', 'race'].map((kind) => `demo_${kind}_${suffix}`);
const password = randomBytes(24).toString('base64url');
const create = (name: string, type: 'empty' | 'seeded' = 'empty') =>
  provisionDemo({ name, type }, process.env.DATABASE_URL_TEST!, password);

// Fingerprint every row of the pre-existing harness tenant, without exposing data.
async function fingerprint() {
  const tables = await queryPublic<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [TEST_SCHEMA_NAME]);
  const hashes: Record<string, string> = {};
  for (const { tablename } of tables) {
    const [row] = await queryPublic<{ hash: string }>(`SELECT md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text), '')) AS hash FROM "${TEST_SCHEMA_NAME}"."${tablename}" t`);
    hashes[tablename] = row!.hash;
  }
  return hashes;
}

afterAll(async () => {
  for (const name of names) {
    await queryPublic(`DROP SCHEMA IF EXISTS "school_${name}" CASCADE`);
    await queryPublic('DELETE FROM public.tenants WHERE schema_name=$1', [`school_${name}`]);
  }
});

describe('demo creation: isolated critical path', () => {
  it('creates a genuinely empty school and rejects collisions without changing existing rows', async () => {
    const before = await fingerprint();
    const result = await create(names[0]!);
    expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
    expect(await fingerprint()).toEqual(before);
    await expect(create(names[0]!)).rejects.toThrow('DEMO_ALREADY_EXISTS');
    const [count] = await queryPublic<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "${result.schemaName}".users`);
    expect(count?.count).toBe(1);
    const token = await signAccessToken({ sub: result.directorId, role: 'director', schemaName: result.schemaName });
    for (const route of ['school-years', 'levels', 'classes', 'subjects', 'grading-periods']) {
      const response = await request().get(`/api/v1/${route}`).set('authorization', `Bearer ${token}`);
      expect(response.status, route).toBe(200);
    }
    // Real dependency: the director cannot open the first year in current V2.
    const denied = await request().post(`/api/v1/admin/schools/${result.tenantId}/school-year/open`)
      .set('authorization', `Bearer ${token}`).send({});
    expect(denied.status).toBe(403);
  });

  it('rolls back schema, registry and director on a late provisioning failure', async () => {
    const check = vi.spyOn(DemoRepository.prototype, 'verify').mockRejectedValueOnce(new Error('injected verification failure'));
    try { await expect(create(names[2]!)).rejects.toThrow('injected verification failure'); }
    finally { check.mockRestore(); }
    const rows = await queryPublic('SELECT 1 FROM pg_namespace WHERE nspname=$1 UNION ALL SELECT 1 FROM public.tenants WHERE schema_name=$1', [`school_${names[2]}`]);
    expect(rows).toHaveLength(0);
    await expect(create(names[2]!)).resolves.toMatchObject({ type: 'empty' });
  });

  it('serializes concurrent requests for the same name', async () => {
    const results = await Promise.allSettled([create(names[3]!), create(names[3]!)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('builds a realistic T3 demo with archived records, conduct, finance and dashboard actions', async () => {
    const before = await fingerprint();
    const result = await create(names[1]!, 'seeded');
    expect(result.counts).toMatchObject({
      students: 72, classes: 6, years: 2, teachers: 6, parents: 72, cards: 162,
      historical_cards: 18, historical_sources: 6, teacher_absences: 24,
      financial_late: 18, active_parent_subscriptions: 36,
      future_evaluations: 6, partially_graded_evaluations: 3,
    });
    const token = await signAccessToken({ sub: result.directorId, role: 'director', schemaName: result.schemaName });
    const periods = await request().get('/api/v1/grading-periods').set('authorization', `Bearer ${token}`);
    expect(periods.status).toBe(200);
    const [activeYear] = await queryPublic<{ id: string }>(
      `SELECT id::text FROM "${result.schemaName}".school_years WHERE status='active'`);
    expect(periods.body.gradingPeriods.filter((p: { schoolYearId: string }) => p.schoolYearId === activeYear.id)
      .map((p: { isCompleted: boolean; isCurrent: boolean }) => [p.isCompleted, p.isCurrent]))
      .toEqual([[true, false], [true, false], [false, true]]);
    const query = (statement: string) => queryPublic(statement.replaceAll('DEMO_SCHEMA', `"${result.schemaName}"`));
    expect(await query("SELECT 1 FROM DEMO_SCHEMA.payments WHERE status NOT IN ('confirmed','cancelled')")).toHaveLength(0);
    expect(await query("SELECT 1 FROM DEMO_SCHEMA.payments WHERE status='cancelled' AND length(btrim(cancellation_reason)) > 0 AND cancelled_by_user_id IS NOT NULL")).toHaveLength(9);
    expect(await query("SELECT 1 FROM DEMO_SCHEMA.student_tuition_overrides WHERE discount_amount > 0")).toHaveLength(18);
    expect(await query('SELECT 1 FROM DEMO_SCHEMA.student_tuition_overrides WHERE discount_amount=30000')).toHaveLength(9);
    expect(await query("SELECT 1 FROM DEMO_SCHEMA.parent_subscriptions WHERE status='active'")).toHaveLength(36);
    expect(await query('SELECT 1 FROM DEMO_SCHEMA.parent_student_links WHERE subscription_id IS NULL')).toHaveLength(12);
    expect(await query("SELECT 1 FROM DEMO_SCHEMA.student_financial_status WHERE status='late'")).toHaveLength(18);
    expect(await query("SELECT 1 FROM DEMO_SCHEMA.report_cards rc JOIN DEMO_SCHEMA.grading_periods gp ON gp.id=rc.grading_period_id JOIN DEMO_SCHEMA.school_years sy ON sy.id=gp.school_year_id WHERE sy.status='closed' AND rc.status='published'")).toHaveLength(18);
    expect(await query('SELECT 1 FROM DEMO_SCHEMA.student_historical_sources')).toHaveLength(6);
    expect(await query("SELECT 1 FROM DEMO_SCHEMA.attendances_teacher WHERE status='absent'")).toHaveLength(24);
    expect(await query("SELECT 1 FROM DEMO_SCHEMA.evaluations e JOIN DEMO_SCHEMA.grading_periods gp ON gp.id=e.grading_period_id JOIN DEMO_SCHEMA.school_years sy ON sy.id=gp.school_year_id WHERE sy.status='active' AND e.evaluation_date > CURRENT_DATE AND NOT EXISTS (SELECT 1 FROM DEMO_SCHEMA.evaluation_grades eg WHERE eg.evaluation_id=e.id)")).toHaveLength(6);
    expect(await query("SELECT e.id FROM DEMO_SCHEMA.evaluations e JOIN DEMO_SCHEMA.grading_periods gp ON gp.id=e.grading_period_id JOIN DEMO_SCHEMA.school_years sy ON sy.id=gp.school_year_id LEFT JOIN DEMO_SCHEMA.evaluation_grades eg ON eg.evaluation_id=e.id WHERE sy.status='active' AND e.evaluation_date <= CURRENT_DATE GROUP BY e.id HAVING COUNT(eg.id) BETWEEN 1 AND 23")).toHaveLength(3);
    expect(await query('SELECT 1 FROM DEMO_SCHEMA.conduct_grades g JOIN DEMO_SCHEMA.students s ON s.id=g.student_id JOIN DEMO_SCHEMA.classes c ON c.id=s.class_id JOIN DEMO_SCHEMA.teachers t ON t.id=c.homeroom_teacher_id WHERE g.decided_by_user_id <> t.user_id')).toHaveLength(0);
    expect(await query('SELECT 1 FROM DEMO_SCHEMA.dashboard_action_items')).toHaveLength(0);
    const first = await runDashboardActionsForSchema({ schemaName: result.schemaName });
    expect(first.generated).toBeGreaterThan(0);
    await runDashboardActionsForSchema({ schemaName: result.schemaName });
    const open = await query('SELECT type, COUNT(*) FROM DEMO_SCHEMA.dashboard_action_items WHERE resolved_at IS NULL GROUP BY type, reference_id HAVING COUNT(*)>1');
    expect(open).toHaveLength(0);
    expect(await fingerprint()).toEqual(before);
    // Tenant-bound claims cannot accidentally read the pre-existing school's classes.
    const classes = await request().get('/api/v1/classes').set('authorization', `Bearer ${token}`);
    expect(classes.body.classes).toHaveLength(3);
    expect(classes.body.classes.some((c: { name: string }) => c.name === getSeedContext().className)).toBe(false);
    // The existing product allows basic access without a paid subscription.
    for (const [phone, subscribed] of [[result.seeded!.parentActive, true], [result.seeded!.parentUnsubscribed, false]] as const) {
      const login = await request().post('/api/v1/auth/login/parent')
        .set('x-tenant-schema', result.schemaName).send({ phone, password });
      expect(login.status).toBe(200);
      const headers = { authorization: `Bearer ${login.body.accessToken}` };
      const children = await request().get('/api/v1/parent/students').set(headers);
      expect(children.status).toBe(200);
      expect(children.body.data).toHaveLength(1);
      const subscription = await request().get('/api/v1/parent/subscription/status').set(headers);
      expect(subscription.status).toBe(200);
      if (subscribed) expect(subscription.body.subscription.status).toBe('active');
      else expect(subscription.body.subscription).toBeNull();
    }
  }, 120_000);
});
