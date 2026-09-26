import { z } from 'zod';
import { IMPORT_PHONE_REGEX } from './import.types.js';

export const HISTORICAL_STUDENT_TARGETS = [
  { key: 'matricule', label: 'Matricule', required: true },
  { key: 'nom', label: 'Nom', required: true },
  { key: 'prenom', label: 'Prénom', required: true },
  { key: 'parent_phone', label: 'Téléphone parent', required: false },
] as const;

export const historicalProfileBodySchema = z.object({
  fields: z.array(z.object({
    sourceColumnLabel: z.string().trim().min(1).max(255),
    targetField: z.string().min(1).max(100),
    isRequired: z.boolean(),
    translations: z.array(z.object({ sourceValue: z.string(), targetValue: z.string() })).max(100),
  }).strict()).min(3).max(4),
}).strict();

export const historicalStudentRowSchema = z.object({
  matricule: z.string().trim().min(1, 'Matricule requis').max(50, 'Matricule trop long'),
  nom: z.string().trim().min(1, 'Nom requis').max(100, 'Nom trop long'),
  prenom: z.string().trim().min(1, 'Prénom requis').max(100, 'Prénom trop long'),
  parent_phone: z.string().trim().regex(IMPORT_PHONE_REGEX, 'Format attendu : 225 suivi de 10 chiffres').or(z.literal('')),
}).strict();
export type HistoricalStudentRow = z.infer<typeof historicalStudentRowSchema> & { rowNumber: number };
export type HistoricalStudentError = { rowNumber: number; field: string; reason: string };
