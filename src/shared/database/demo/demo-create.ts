import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDemoOptions } from './demo.config.js';
import { provisionDemo } from './demo.service.js';

async function main() {
  if (process.argv.includes('--help')) {
    console.info('npm run demo:create -- --name=demo_t3 --type=seeded|empty\nNom neuf requis ; aucun remplacement. Connexion PostgreSQL locale uniquement.');
    return;
  }
  const options = parseDemoOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED');
  const password = randomBytes(24).toString('base64url');
  const directory = resolve('.tmp/demos');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // Reserve a private credential file before any database write. Never overwrite one.
  const credentialPath = resolve(directory, `${options.name}-${randomBytes(6).toString('hex')}.json`);
  const credentials = await open(credentialPath, 'wx', 0o600);
  try {
    await credentials.writeFile(JSON.stringify({ status: 'provisioning', password }) + '\n');
    const result = await provisionDemo(options, databaseUrl, password);
    await credentials.truncate(0);
    await credentials.write(JSON.stringify({ ...result, password }, null, 2) + '\n', 0, 'utf8');
    if (options.type === 'seeded') {
      // Same tenant-scoped handler as server.ts, no global cron or notification queue.
      const { runDashboardActionsForSchema } = await import('../../../modules/dashboard-actions/dashboard-actions.worker.js');
      const actions = await runDashboardActionsForSchema({ schemaName: result.schemaName }).catch(() => {
        throw new Error(`DEMO_ACTIONS_FAILED: tenant créé ; accès dans ${credentialPath}. Vérifier le job dashboard avant présentation.`);
      });
      if (actions.generated < 1) throw new Error(`DEMO_ACTIONS_EMPTY: tenant créé ; accès dans ${credentialPath}. Vérifier le job dashboard avant présentation.`);
      console.info(JSON.stringify({ tenantId: result.tenantId, counts: result.counts, actions: actions.generated }));
    } else console.info(JSON.stringify({ tenantId: result.tenantId, counts: result.counts }));
    console.info(`Accès de démonstration enregistrés dans ${credentialPath}`);
  } finally {
    await credentials.close();
  }
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  // SQL errors can include credentials/PII in their parameters: never print their cause.
  const message = error instanceof Error ? error.message : 'DEMO_FAILED';
  console.error(message.startsWith('DEMO_') ? message : 'DEMO_FAILED: vérifier les paramètres, la connexion et le fichier privé .tmp/demos.');
  process.exit(1);
});
