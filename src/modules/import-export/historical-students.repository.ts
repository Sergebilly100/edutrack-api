import { sql } from 'drizzle-orm';
import type { TenantDb } from '../../shared/database/db.js';
import { MappingRepository } from '../../shared/import-mapping/mapping.repository.js';
import type { HistoricalStudentError, HistoricalStudentRow } from './historical-students.types.js';

export class HistoricalStudentsRepository extends MappingRepository {
  constructor(db: TenantDb) { super(db); }

  async isInitialConfiguration(): Promise<boolean> {
    const result = await this.db.execute<{ onboarding_completed: boolean }>(sql`
      SELECT onboarding_completed FROM public.tenants WHERE schema_name = current_schema() LIMIT 1
    `);
    return result.rows[0]?.onboarding_completed === false;
  }

  async confirmRows(input: HistoricalStudentRow[], actorUserId: string) {
    return this.db.transaction(async (tx) => {
      let createdCount = 0;
      let reusedCount = 0;
      const errors: HistoricalStudentError[] = [];
      for (const row of input) {
        try {
          const outcome = await tx.transaction(async (lineTx) => {
            // Serialize retries by normalized school identifier, including case variants.
            await lineTx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(lower(btrim(${row.matricule}))))`);
            const existing = await lineTx.execute<{ first_name: string; last_name: string }>(sql`
              SELECT first_name, last_name FROM students
              WHERE lower(btrim(matricule)) = lower(btrim(${row.matricule})) LIMIT 1
            `);
            if (existing.rows[0]) {
              return existing.rows[0].first_name === row.prenom && existing.rows[0].last_name === row.nom
                ? 'reused' : 'conflict';
            }
            await lineTx.execute(sql`
              INSERT INTO students (matricule, first_name, last_name, parent_phone)
              VALUES (${row.matricule}, ${row.prenom}, ${row.nom}, ${row.parent_phone || null})
            `);
            return 'created';
          });
          if (outcome === 'created') createdCount += 1;
          else if (outcome === 'reused') reusedCount += 1;
          else errors.push({ rowNumber: row.rowNumber, field: 'matricule', reason: 'Matricule déjà utilisé par un autre profil' });
        } catch {
          // Never return PostgreSQL details: they may contain personal data.
          errors.push({ rowNumber: row.rowNumber, field: 'profil', reason: 'Enregistrement impossible, corrigez la ligne puis réessayez' });
        }
      }
      await tx.execute(sql`
        INSERT INTO import_history (import_type, imported_count, updated_count, imported_by, imported_by_role)
        VALUES ('students', ${createdCount}, 0, ${actorUserId}::uuid, 'director')
      `);
      return { createdCount, reusedCount, errors };
    });
  }
}
