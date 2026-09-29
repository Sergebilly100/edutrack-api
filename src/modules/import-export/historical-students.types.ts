import { z } from 'zod';
import { IMPORT_PHONE_REGEX } from './import.types.js';

export const HISTORICAL_STUDENT_TARGETS = [
  { key: 'matricule', label: 'Matricule', required: false, aliases: ['matricule'] },
  { key: 'nom', label: 'Nom', required: true, aliases: ['nom', 'nom*'] },
  { key: 'prenom', label: 'Prénom', required: true, aliases: ['prénom', 'prénom*', 'prenom'] },
  { key: 'historical_class', label: 'Ancienne classe', required: false, aliases: ['classe*', 'classe', 'ancienne classe'] },
  { key: 'birth_date', label: 'Date de naissance', required: false, aliases: ['date de naissance', 'birth_date'] },
  { key: 'parent_name', label: 'Nom parent', required: false, aliases: ['nom parent', 'parent_name'] },
  { key: 'parent_phone', label: 'Téléphone parent', required: false, aliases: ['téléphone parent', 'parent_phone'] },
  { key: 'parent_email', label: 'Email parent', required: false, aliases: ['email parent', 'parent_email'] },
  { key: 'parent_name_2', label: 'Nom parent 2', required: false, aliases: ['nom parent 2', 'parent_name_2'] },
  { key: 'parent_phone_2', label: 'Téléphone parent 2', required: false, aliases: ['téléphone parent 2', 'parent_phone_2'] },
] as const;

export const historicalSchoolYearSchema = z.string().trim()
  .transform((value) => value.replace(/\s/g, '').replace('/', '-'))
  .refine((value) => /^\d{4}-\d{4}$/.test(value)
    && Number(value.slice(0, 4)) >= 1900
    && Number(value.slice(5)) === Number(value.slice(0, 4)) + 1,
  'Année attendue : 2024-2025, avec deux années consécutives');
export const historicalImportRequestSchema = z.object({ schoolYearLabel: historicalSchoolYearSchema });
export const historicalProfileBodySchema = z.object({
  fields: z.array(z.object({
    sourceColumnLabel: z.string().trim().min(1).max(255),
    targetField: z.string().min(1).max(100),
    isRequired: z.boolean(),
    translations: z.array(z.object({ sourceValue: z.string(), targetValue: z.string() })).max(100),
  }).strict()).min(2).max(HISTORICAL_STUDENT_TARGETS.length),
}).strict();

const optionalPhone = z.string().trim().regex(IMPORT_PHONE_REGEX, 'Format attendu : 225 suivi de 10 chiffres').or(z.literal('')).default('');
const optionalName = z.string().trim().max(255, 'Nom trop long').default('');
export const historicalStudentRowSchema = z.object({
  matricule: z.string().trim().max(50, 'Matricule trop long').default(''),
  nom: z.string().trim().min(1, 'Nom requis').max(100, 'Nom trop long'),
  prenom: z.string().trim().min(1, 'Prénom requis').max(100, 'Prénom trop long'),
  historical_class: z.string().trim().max(100, 'Classe historique trop longue').default(''),
  birth_date: z.iso.date('Date invalide : utilisez YYYY-MM-DD ou JJ/MM/AAAA').or(z.literal('')).default(''),
  parent_name: optionalName,
  parent_phone: optionalPhone,
  parent_email: z.string().trim().max(255, 'Email parent trop long').email('Email parent invalide').or(z.literal('')).default(''),
  parent_name_2: optionalName,
  parent_phone_2: optionalPhone,
}).strict();
export type HistoricalStudentRow = z.infer<typeof historicalStudentRowSchema> & { rowNumber: number; sheetName?: string };
export type HistoricalStudentError = { rowNumber: number; field: string; reason: string; code?: string; sheetName?: string };
