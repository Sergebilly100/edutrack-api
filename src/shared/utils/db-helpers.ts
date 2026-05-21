import type { QueryResult, QueryResultRow } from 'pg';

export const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] =>
  result.rows;

export const getRowsUntyped = <TRow>(result: unknown): TRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as { rows: TRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};
