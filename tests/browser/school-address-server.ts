/** Minimal, disposable browser fixture for the real school-address routes. */
if (!process.env.DATABASE_URL_TEST || !process.env.QA_BROWSER_SCHEMA?.startsWith('school_test_')) {
  throw new Error('School address browser QA requires DATABASE_URL_TEST and a school_test_* schema');
}
process.env.AUTH_ADMIN_SCHEMA = process.env.QA_BROWSER_SCHEMA;
process.env.SMS_MOCK = 'true';

const { startTestApp, stopTestApp, queryPublic, TEST_SCHEMA_NAME } = await import('../support/school-harness.js');
await startTestApp();
const { db } = await import('../../src/shared/database/db.js');
const { ensureAdminPublicInfrastructure } = await import('../../src/modules/admin/admin.infrastructure.service.js');
await ensureAdminPublicInfrastructure(db);
await queryPublic(`INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, city, onboarding_completed)
  VALUES ('École QA C15', $1, $2, 'pro', 'active', 'Abidjan', false)`,
  [TEST_SCHEMA_NAME.replaceAll('_', '-'), TEST_SCHEMA_NAME]);
process.env.QA_BROWSER_READY = 'true';

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await stopTestApp();
  process.exit(0);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
