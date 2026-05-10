import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Generic database helpers pour éliminer duplication
 */

export const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] =>
  result.rows;

export const mapRows = <TRow extends QueryResultRow, TMapped>(
  result: QueryResult<TRow>,
  mapper: (row: TRow) => TMapped
): TMapped[] => {
  return getRows(result).map(mapper);
};
