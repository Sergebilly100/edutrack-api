/**
 * Correctif sécurité : force must_change_password = true sur les profs importés.
 *
 * Les profs créés par l'import Excel de masse (import.repository.ts) partageaient
 * le même mot de passe par défaut (IMPORT_TEACHER_DEFAULT_PASSWORD) SANS être
 * forcés de le changer (la colonne users.must_change_password a un DEFAULT false).
 * Le code d'import a été corrigé pour les nouveaux imports ; ce script rattrape
 * les profs déjà en base.
 *
 * Cible précise : role='teacher' ET credentials_sent_at IS NULL. Ce filtre
 * isole les profs jamais passés par la régénération individuelle de credentials
 * (teachers.repository.ts pose credentials_sent_at = NOW()), donc ceux qui ont
 * encore potentiellement le mot de passe partagé. On ne touche pas aux profs
 * ayant déjà un mot de passe personnel.
 *
 *   npx tsx scripts/fix-imported-teachers-must-change-password.ts          # dry-run (défaut)
 *   npx tsx scripts/fix-imported-teachers-must-change-password.ts --apply  # applique
 */
import 'dotenv/config';

import { Pool } from 'pg';

type SchemaRow = { schema_name: string };

const SCHEMA_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}$/;

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("✗ DATABASE_URL manquant dans l'environnement.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Schémas tenant réellement provisionnés (status actif/essai + schéma PG existant
    // contenant la table users). On ignore les lignes orphelines de public.tenants.
    const { rows: schemas } = await pool.query<SchemaRow>(
      `SELECT t.schema_name
       FROM public.tenants t
       WHERE t.status IN ('trial', 'active')
         AND EXISTS (
           SELECT 1 FROM information_schema.tables tab
           WHERE tab.table_schema = t.schema_name
             AND tab.table_name = 'users'
         )
       ORDER BY t.created_at ASC`
    );

    console.log(`→ ${schemas.length} schéma(s) tenant à inspecter.`);

    let totalCandidates = 0;
    let totalUpdated = 0;

    for (const { schema_name: schema } of schemas) {
      if (!SCHEMA_NAME_REGEX.test(schema)) {
        console.warn(`   ⚠ schéma ignoré (nom invalide) : ${schema}`);
        continue;
      }

      const quoted = `"${schema}"`;

      const { rows: countRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM ${quoted}.users
         WHERE role = 'teacher'
           AND credentials_sent_at IS NULL
           AND must_change_password = false`
      );
      const candidates = Number(countRows[0]?.count ?? 0);
      totalCandidates += candidates;

      if (candidates === 0) {
        continue;
      }

      if (!apply) {
        console.log(`   • ${schema} : ${candidates} prof(s) à corriger`);
        continue;
      }

      const result = await pool.query(
        `UPDATE ${quoted}.users
         SET must_change_password = true
         WHERE role = 'teacher'
           AND credentials_sent_at IS NULL
           AND must_change_password = false`
      );
      totalUpdated += result.rowCount ?? 0;
      console.log(`   ✓ ${schema} : ${result.rowCount} prof(s) corrigé(s)`);
    }

    if (totalCandidates === 0) {
      console.log('✓ Aucun prof à corriger.');
      return;
    }

    if (!apply) {
      console.log(
        `\nℹ Dry-run : ${totalCandidates} prof(s) seraient corrigé(s). Relancez avec --apply.`
      );
      return;
    }

    console.log(`\n✓ ${totalUpdated} prof(s) passé(s) à must_change_password = true.`);
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error('\n✗ Échec de la correction must_change_password');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
