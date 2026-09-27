import { sql } from 'drizzle-orm';
import type { TenantDb } from '../../shared/database/db.js';
import { MappingRepository } from '../../shared/import-mapping/mapping.repository.js';
import { historicalStudentKey } from './historical-students.identity.js';
import type { HistoricalStudentError, HistoricalStudentRow } from './historical-students.types.js';

type ExistingProfile = { id: string; first_name: string; last_name: string };

export class HistoricalStudentsRepository extends MappingRepository {
  constructor(db: TenantDb) { super(db); }

  async isInitialConfiguration(): Promise<boolean> {
    const result = await this.db.execute<{ onboarding_completed: boolean }>(sql`
      SELECT onboarding_completed FROM public.tenants WHERE schema_name = current_schema() LIMIT 1
    `);
    return result.rows[0]?.onboarding_completed === false;
  }

  async withInitialConfiguration<T>(operation: (database: TenantDb) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      // Closing onboarding and confirming a lot cannot race past each other.
      const access = await tx.execute<{ onboarding_completed: boolean }>(sql`
        SELECT onboarding_completed FROM public.tenants WHERE schema_name = current_schema() FOR UPDATE
      `);
      if (access.rows[0]?.onboarding_completed !== false) throw new Error('Initial import closed');
      return operation(tx as TenantDb);
    });
  }

  async confirmRows(input: HistoricalStudentRow[], actorUserId: string, schoolYearLabel: string) {
    return this.withInitialConfiguration(async (tx) => {
      const history = await tx.execute<{ id: string }>(sql`
        INSERT INTO import_history (import_type, imported_count, updated_count, imported_by, imported_by_role, historical_school_year_label)
        VALUES ('students', 0, 0, ${actorUserId}::uuid, 'director', ${schoolYearLabel}) RETURNING id
      `);
      const historyId = history.rows[0]!.id;
      let createdCount = 0;
      let reusedCount = 0;
      const errors: HistoricalStudentError[] = [];
      for (const row of input) {
        try {
          const outcome = await tx.transaction(async (lineTx) => {
            const key = historicalStudentKey(row);
            await lineTx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${key}))`);
            const existing = row.matricule
              ? await lineTx.execute<ExistingProfile>(sql`
                SELECT id, first_name, last_name FROM students
                WHERE lower(btrim(matricule)) = lower(btrim(${row.matricule})) LIMIT 1
              `)
              : await lineTx.execute<ExistingProfile>(sql`
                SELECT s.id, s.first_name, s.last_name FROM students s
                JOIN student_historical_sources h ON h.student_id = s.id
                WHERE h.school_year_label = ${schoolYearLabel} AND h.row_key = ${key} LIMIT 1
              `);
            let studentId = existing.rows[0]?.id;
            if (existing.rows[0] && (existing.rows[0].first_name !== row.prenom || existing.rows[0].last_name !== row.nom)) return 'conflict';
            if (!studentId && !row.matricule) {
              const ambiguous = await lineTx.execute(sql`
                SELECT id FROM students WHERE lower(btrim(first_name)) = lower(btrim(${row.prenom}))
                  AND lower(btrim(last_name)) = lower(btrim(${row.nom}))
                  AND birth_date IS NOT DISTINCT FROM ${row.birth_date || null}::date LIMIT 1
              `);
              if (ambiguous.rows.length) return 'ambiguous';
            }
            const reused = Boolean(studentId);
            if (!studentId) {
              const inserted = await lineTx.execute<{ id: string }>(sql`
                INSERT INTO students (matricule, first_name, last_name, birth_date,
                  parent_name, parent_phone, parent_email, parent_name_2, parent_phone_2)
                VALUES (${row.matricule || null}, ${row.prenom}, ${row.nom}, ${row.birth_date || null}::date,
                  ${row.parent_name || null}, ${row.parent_phone || null}, ${row.parent_email || null},
                  ${row.parent_name_2 || null}, ${row.parent_phone_2 || null}) RETURNING id
              `);
              studentId = inserted.rows[0]!.id;
            }
            await lineTx.execute(sql`
              INSERT INTO student_historical_sources (student_id, school_year_label, old_class_name, row_key, import_history_id)
              VALUES (${studentId}::uuid, ${schoolYearLabel}, ${row.historical_class || null}, ${key}, ${historyId}::uuid)
              ON CONFLICT (student_id, school_year_label) DO UPDATE SET
                old_class_name = COALESCE(EXCLUDED.old_class_name, student_historical_sources.old_class_name),
                row_key = EXCLUDED.row_key, import_history_id = EXCLUDED.import_history_id
            `);
            return reused ? 'reused' : 'created';
          });
          if (outcome === 'created') createdCount += 1;
          else if (outcome === 'reused') reusedCount += 1;
          else errors.push({ rowNumber: row.rowNumber, ...(row.sheetName ? { sheetName: row.sheetName } : {}), field: 'matricule',
            reason: outcome === 'ambiguous' ? 'Renseignez un matricule pour distinguer ce profil d’un élève déjà présent' : 'Matricule déjà utilisé par un autre profil' });
        } catch {
          errors.push({ rowNumber: row.rowNumber, ...(row.sheetName ? { sheetName: row.sheetName } : {}), field: 'profil', reason: 'Enregistrement impossible, corrigez la ligne puis réessayez' });
        }
      }
      await tx.execute(sql`UPDATE import_history SET imported_count = ${createdCount} WHERE id = ${historyId}::uuid`);
      return { createdCount, reusedCount, errors };
    });
  }
}
