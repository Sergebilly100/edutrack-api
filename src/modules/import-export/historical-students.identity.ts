import { createHash } from 'node:crypto';
import { normalizeMappingLabel } from '../../shared/import-mapping/engine.js';
import { matriculeKey } from '../../shared/utils/matricule.js';
import type { HistoricalStudentRow } from './historical-students.types.js';

export const historicalStudentKey = (row: HistoricalStudentRow): string => createHash('sha256').update(
  row.matricule ? `matricule:${matriculeKey(row.matricule)}`
    : JSON.stringify([row.nom, row.prenom, row.birth_date, row.historical_class].map(normalizeMappingLabel)),
).digest('hex');
