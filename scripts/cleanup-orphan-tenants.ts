/**
 * Nettoyage des tenants orphelins.
 *
 * public.tenants accumule des lignes en status 'trial'/'active' dont le schéma
 * PostgreSQL n'existe pas (tests d'intégration qui suppriment le schéma sans
 * nettoyer la ligne catalogue). Ces orphelins faisaient enregistrer des
 * schedulers cron morts (mark-absences) qui plantaient en boucle.
 *
 * Ce script NE SUPPRIME PAS de lignes (risque FK billing/subscriptions) :
 * il passe leur status à 'cancelled' (valeur neutre de l'enum tenant_status).
 *
 *   npx tsx scripts/cleanup-orphan-tenants.ts            # dry-run (défaut)
 *   npx tsx scripts/cleanup-orphan-tenants.ts --apply    # applique le changement
 */
import 'dotenv/config';

import { Pool } from 'pg';

type OrphanRow = { id: string; schema_name: string; status: string };

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('✗ DATABASE_URL manquant dans l\'environnement.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const { rows: orphans } = await pool.query<OrphanRow>(
      `SELECT t.id::text AS id, t.schema_name, t.status::text AS status
       FROM public.tenants t
       WHERE t.status IN ('trial', 'active')
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.schemata s
           WHERE s.schema_name = t.schema_name
         )
       ORDER BY t.created_at ASC`
    );

    console.log(`→ ${orphans.length} tenant(s) orphelin(s) trouvé(s) (status active/trial sans schéma PG).`);
    for (const row of orphans.slice(0, 10)) {
      console.log(`   • ${row.schema_name} (${row.id}) [${row.status}]`);
    }
    if (orphans.length > 10) {
      console.log(`   … et ${orphans.length - 10} de plus.`);
    }

    if (orphans.length === 0) {
      console.log('✓ Rien à nettoyer.');
      return;
    }

    if (!apply) {
      console.log('\nℹ Dry-run. Relancez avec --apply pour passer ces tenants en status \'cancelled\'.');
      return;
    }

    const result = await pool.query(
      `UPDATE public.tenants
       SET status = 'cancelled'
       WHERE status IN ('trial', 'active')
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.schemata s
           WHERE s.schema_name = public.tenants.schema_name
         )`
    );

    console.log(`\n✓ ${result.rowCount} tenant(s) orphelin(s) passé(s) en status 'cancelled'.`);
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error('\n✗ Échec du nettoyage des tenants orphelins');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
