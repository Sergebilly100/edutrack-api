import { sql } from 'drizzle-orm';
import type { TenantDb } from '../../shared/database/db.js';

const rows = <T>(result: unknown): T[] =>
  typeof result === 'object' && result !== null && 'rows' in result
    ? ((result as { rows: T[] }).rows ?? []) : [];

export type RecoveryClassRow = {
  class_id: string; class_name: string; level_id: string; level_name: string;
  student_count: number; expected: string; paid: string;
  remaining: string; students_to_follow: number;
};

export type RecoveryStudentRow = {
  student_id: string; full_name: string; matricule: string | null;
  status: 'up_to_date' | 'late' | null;
  expected: string; paid: string; remaining: string;
  days_late: number | null;
};

export class RecoveryRepository {
  constructor(private readonly db: TenantDb) {}

  async listYears(): Promise<Array<{ id: string; label: string; status: string }>> {
    const result = await this.db.execute<{ id: string; label: string; status: string }>(sql`
      SELECT id::text, label, status::text
      FROM school_years
      WHERE status <> 'draft'
      ORDER BY start_date DESC, label DESC
    `);
    return rows(result);
  }

  async yearExists(yearId: string): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM school_years WHERE id = ${yearId}::uuid AND status <> 'draft') AS exists
    `);
    return rows<{ exists: boolean }>(result)[0]?.exists === true;
  }

  async levelExists(levelId: string, yearId: string): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM classes WHERE level_id = ${levelId}::uuid
        AND school_year_id = ${yearId}::uuid AND is_active = true) AS exists
    `);
    return rows<{ exists: boolean }>(result)[0]?.exists === true;
  }

  async classExists(classId: string, yearId: string, levelId?: string): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM classes WHERE id = ${classId}::uuid
        AND school_year_id = ${yearId}::uuid AND is_active = true
        AND (${levelId ?? null}::uuid IS NULL OR level_id = ${levelId ?? null}::uuid)) AS exists
    `);
    return rows<{ exists: boolean }>(result)[0]?.exists === true;
  }

  async listClasses(yearId: string, levelId?: string, classId?: string): Promise<RecoveryClassRow[]> {
    const result = await this.db.execute<RecoveryClassRow>(sql`
      SELECT c.id::text AS class_id, c.name AS class_name,
             l.id::text AS level_id, l.name AS level_name,
             COUNT(*)::int AS student_count,
             COALESCE(SUM(sfs.total_expected_to_date), 0)::text AS expected,
             COALESCE(SUM(sfs.total_paid), 0)::text AS paid,
             COALESCE(SUM(GREATEST(COALESCE(sfs.total_expected_to_date, 0)
               - COALESCE(sfs.total_paid, 0), 0)), 0)::text AS remaining,
             COUNT(*) FILTER (WHERE sfs.status = 'late')::int AS students_to_follow
      FROM enrollments e
      INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = e.school_year_id AND c.is_active = true
      INNER JOIN levels l ON l.id = c.level_id
      LEFT JOIN student_financial_status sfs ON sfs.student_id = s.id AND sfs.school_year_id = e.school_year_id
      WHERE e.school_year_id = ${yearId}::uuid AND e.status = 'confirmed'
        AND (${levelId ?? null}::uuid IS NULL OR c.level_id = ${levelId ?? null}::uuid)
        AND (${classId ?? null}::uuid IS NULL OR c.id = ${classId ?? null}::uuid)
      GROUP BY c.id, c.name, l.id, l.name, l.order_index
      ORDER BY l.order_index, l.name, c.name
    `);
    return rows(result);
  }

  private classStudentFilter(search?: string, status?: 'late' | 'up_to_date') {
    const pattern = search ? `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
    return sql`
      AND (${pattern}::text IS NULL
           OR concat_ws(' ', s.first_name, s.last_name) ILIKE ${pattern}
           OR concat_ws(' ', s.last_name, s.first_name) ILIKE ${pattern}
           OR COALESCE(s.matricule, '') ILIKE ${pattern})
      AND (${status ?? null}::text IS NULL OR sfs.status::text = ${status ?? null})
    `;
  }

  async countClassStudents(yearId: string, classId: string, search?: string, status?: 'late' | 'up_to_date'): Promise<number> {
    const result = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count FROM enrollments e
      INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
      LEFT JOIN student_financial_status sfs ON sfs.student_id = s.id AND sfs.school_year_id = e.school_year_id
      WHERE e.school_year_id = ${yearId}::uuid AND e.class_id = ${classId}::uuid AND e.status = 'confirmed'
      ${this.classStudentFilter(search, status)}
    `);
    return Number(rows<{ count: number }>(result)[0]?.count ?? 0);
  }

  /** Compteurs des pastilles : indépendants de la recherche et du filtre de statut. */
  async countClassStudentsByStatus(yearId: string, classId: string): Promise<{ all: number; late: number; upToDate: number }> {
    const result = await this.db.execute<{ all_count: number; late_count: number; up_to_date_count: number }>(sql`
      SELECT COUNT(*)::int AS all_count,
             COUNT(*) FILTER (WHERE sfs.status = 'late')::int AS late_count,
             COUNT(*) FILTER (WHERE sfs.status = 'up_to_date')::int AS up_to_date_count
      FROM enrollments e
      INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
      LEFT JOIN student_financial_status sfs ON sfs.student_id = s.id AND sfs.school_year_id = e.school_year_id
      WHERE e.school_year_id = ${yearId}::uuid AND e.class_id = ${classId}::uuid AND e.status = 'confirmed'
    `);
    const row = rows<{ all_count: number; late_count: number; up_to_date_count: number }>(result)[0];
    return { all: Number(row?.all_count ?? 0), late: Number(row?.late_count ?? 0), upToDate: Number(row?.up_to_date_count ?? 0) };
  }

  async listClassStudents(yearId: string, classId: string, limit: number, offset: number, search?: string, status?: 'late' | 'up_to_date'): Promise<RecoveryStudentRow[]> {
    const result = await this.db.execute<RecoveryStudentRow>(sql`
      SELECT s.id::text AS student_id,
             format_person_name(s.first_name, s.last_name) AS full_name,
             s.matricule, sfs.status::text,
             COALESCE(sfs.total_expected_to_date, 0)::text AS expected,
             COALESCE(sfs.total_paid, 0)::text AS paid,
             GREATEST(COALESCE(sfs.total_expected_to_date, 0)
               - COALESCE(sfs.total_paid, 0), 0)::text AS remaining,
             sfs.days_late
      FROM enrollments e
      INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = e.school_year_id AND c.is_active = true
      LEFT JOIN student_financial_status sfs ON sfs.student_id = s.id AND sfs.school_year_id = e.school_year_id
      WHERE e.school_year_id = ${yearId}::uuid AND e.class_id = ${classId}::uuid AND e.status = 'confirmed'
      ${this.classStudentFilter(search, status)}
      ORDER BY CASE WHEN sfs.status = 'late' THEN 0 ELSE 1 END,
               sfs.days_late DESC NULLS LAST, s.last_name, s.first_name, s.id
      LIMIT ${limit} OFFSET ${offset}
    `);
    return rows(result);
  }
}
