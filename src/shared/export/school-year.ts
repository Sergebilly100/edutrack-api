import { sql } from 'drizzle-orm';

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[];

export type ExportSchoolYear = { id: string; label: string };

/** Année demandée, ou année active par défaut. `null` si elle n'existe pas (ou s'il n'y a pas d'année active). */
export const resolveExportSchoolYear = async (db: Executor, schoolYearId?: string): Promise<ExportSchoolYear | null> => {
  const result = await db.execute(schoolYearId
    ? sql`SELECT id::text AS id, label FROM school_years WHERE id = ${schoolYearId}::uuid LIMIT 1`
    : sql`SELECT id::text AS id, label FROM school_years WHERE status = 'active' ORDER BY start_date DESC LIMIT 1`);
  return rowsOf<ExportSchoolYear>(result)[0] ?? null;
};
