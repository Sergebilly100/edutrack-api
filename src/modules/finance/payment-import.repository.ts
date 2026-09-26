import { sql } from 'drizzle-orm';
import { MappingRepository } from '../../shared/import-mapping/mapping.repository.js';
export type { MappingProfile } from '../../shared/import-mapping/mapping.repository.js';

const resultRows = <T>(result: unknown): T[] =>
  typeof result === 'object' && result !== null && 'rows' in result
    ? ((result as { rows: T[] }).rows ?? [])
    : [];

export class PaymentImportRepository extends MappingRepository {
  async getActiveSchoolYear(): Promise<{ id: string; start_date: string; end_date: string } | null> {
    const result = await this.db.execute<{ id: string; start_date: string; end_date: string }>(sql`
      SELECT id::text, start_date::text, end_date::text
      FROM school_years WHERE status = 'active' LIMIT 1
    `);
    return resultRows<{ id: string; start_date: string; end_date: string }>(result)[0] ?? null;
  }

  async findStudentByMatricule(matricule: string): Promise<{
    id: string; matricule: string; student_name: string; class_name: string;
  } | null> {
    const result = await this.db.execute<{
      id: string; matricule: string; student_name: string; class_name: string;
    }>(sql`
      SELECT s.id::text, s.matricule,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             c.name AS class_name
      FROM students_with_class s
      INNER JOIN classes c ON c.id = s.class_id
      WHERE lower(btrim(s.matricule)) = lower(btrim(${matricule}))
      LIMIT 1
    `);
    return resultRows<{
      id: string; matricule: string; student_name: string; class_name: string;
    }>(result)[0] ?? null;
  }
}
