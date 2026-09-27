import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TenantDb } from '../../shared/database/db.js';
import { normalizeMappingLabel, resolveMappingByHeaders, translateMappedValue, type MappingFieldDefinition } from '../../shared/import-mapping/engine.js';
import { parseMappingWorkbook, type ParsedMappingWorkbook } from '../../shared/import-mapping/workbook.js';
import { ImportModuleError } from './import.service.js';
import { HistoricalStudentsRepository } from './historical-students.repository.js';
import { historicalStudentKey } from './historical-students.identity.js';
import { HISTORICAL_STUDENT_TARGETS, historicalSchoolYearSchema, historicalStudentRowSchema, type HistoricalStudentError, type HistoricalStudentRow } from './historical-students.types.js';

const PROFILE_TYPE = 'historical_students';
const IGNORED_SHEETS = ['README', 'Info', 'INSTRUCTIONS', 'Salles (référence)'];
const GENERIC_SHEETS = ['historique', 'profils historiques', 'élèves', 'eleves', 'students', 'sheet1', 'feuil1'];

export const resolveInitialImportAccess = (initialConfiguration: boolean, role: string) => ({
  initialConfiguration,
  canImportProfiles: initialConfiguration && role === 'director',
});

export const validateHistoricalMapping = (fields: MappingFieldDefinition[]): MappingFieldDefinition[] => {
  const targets = fields.map((field) => field.targetField);
  const sources = fields.map((field) => normalizeMappingLabel(field.sourceColumnLabel));
  if (new Set(targets).size !== targets.length || new Set(sources).size !== sources.length) {
    throw new ImportModuleError('Chaque colonne et chaque champ ne peuvent être associés qu’une fois', 400, 'MAPPING_TARGET_DUPLICATED');
  }
  if (targets.some((key) => !HISTORICAL_STUDENT_TARGETS.some((target) => target.key === key))) {
    throw new ImportModuleError('Champ non autorisé pour un profil historique', 400, 'MAPPING_TARGET_UNKNOWN');
  }
  if (HISTORICAL_STUDENT_TARGETS.some((target) => target.required && !targets.includes(target.key))) {
    throw new ImportModuleError('Associez le nom et le prénom', 400, 'MAPPING_REQUIRED_FIELDS_MISSING');
  }
  return fields.map((field) => ({ ...field, isRequired: HISTORICAL_STUDENT_TARGETS.find((target) => target.key === field.targetField)!.required }));
};

// Preserve saved choices first; aliases must not steal a column from another target.
export const resolveHistoricalFields = (headers: string[], saved: MappingFieldDefinition[] = []): MappingFieldDefinition[] => {
  const fields: MappingFieldDefinition[] = [];
  const usedColumns = new Set<string>();
  for (const target of HISTORICAL_STUDENT_TARGETS) {
    const previous = saved.find((field) => field.targetField === target.key);
    const header = previous && headers.find((value) => normalizeMappingLabel(value) === normalizeMappingLabel(previous.sourceColumnLabel));
    if (header && !usedColumns.has(normalizeMappingLabel(header))) {
      fields.push({ targetField: target.key, sourceColumnLabel: header, isRequired: target.required, translations: previous!.translations });
      usedColumns.add(normalizeMappingLabel(header));
    }
  }
  for (const target of HISTORICAL_STUDENT_TARGETS) {
    if (fields.some((field) => field.targetField === target.key)) continue;
    const aliases = [target.key, target.label, ...target.aliases].map(normalizeMappingLabel);
    const header = headers.find((value) => aliases.includes(normalizeMappingLabel(value)) && !usedColumns.has(normalizeMappingLabel(value)));
    if (header) {
      fields.push({ targetField: target.key, sourceColumnLabel: header, isRequired: target.required, translations: [] });
      usedColumns.add(normalizeMappingLabel(header));
    }
  }
  return fields;
};

const normalizeBirthDate = (value: string): string => {
  const parts = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return parts ? `${parts[3]}-${parts[2]!.padStart(2, '0')}-${parts[1]!.padStart(2, '0')}` : value;
};

export const validateHistoricalRows = (workbook: ParsedMappingWorkbook, fields: MappingFieldDefinition[]) => {
  const resolution = resolveMappingByHeaders(workbook.headers, validateHistoricalMapping(fields));
  if (resolution.missingRequiredTargets.length) {
    throw new ImportModuleError(`Colonnes introuvables : ${resolution.missingRequiredTargets.join(', ')}`, 422, 'MAPPING_COLUMNS_MISSING');
  }
  const rows: HistoricalStudentRow[] = [];
  const errors: HistoricalStudentError[] = [];
  const identities = new Set<string>();
  const preview: Array<{ rowNumber: number; sheetName?: string; values: Record<string, string> }> = [];
  for (const row of workbook.rows) {
    const location = { rowNumber: row.rowNumber, ...(row.sheetName ? { sheetName: row.sheetName } : {}) };
    const values = Object.fromEntries(HISTORICAL_STUDENT_TARGETS.map((target) => {
      const field = resolution.matched.find((candidate) => candidate.targetField === target.key);
      const raw = field ? String(row.values[field.sourceColumnLabel] ?? '').trim() : '';
      return [target.key, field ? translateMappedValue(field, raw) ?? raw : raw];
    }));
    values.birth_date = normalizeBirthDate(values.birth_date!);
    const sheetName = row.sheetName ?? workbook.sheetName;
    if (!values.historical_class && !GENERIC_SHEETS.includes(normalizeMappingLabel(sheetName))) values.historical_class = sheetName;
    if (preview.length < 10) preview.push({ ...location, values });
    const parsed = historicalStudentRowSchema.safeParse(values);
    if (!parsed.success) {
      errors.push(...parsed.error.issues.map((issue) => ({ ...location, field: String(issue.path[0]), reason: issue.message })));
      continue;
    }
    const profile = { ...parsed.data, ...location };
    const key = historicalStudentKey(profile);
    if (identities.has(key)) {
      errors.push({ ...location, field: profile.matricule ? 'matricule' : 'profil', reason: 'Profil dupliqué dans le fichier' });
      continue;
    }
    identities.add(key);
    rows.push(profile);
  }
  return { rows, errors, preview, resolution };
};

export class HistoricalStudentsService {
  constructor(private readonly repository: HistoricalStudentsRepository) {}

  async getAccess(role: string) {
    return resolveInitialImportAccess(await this.repository.isInitialConfiguration(), role);
  }

  async assertDirector(role: string) {
    if (role !== 'director') throw new ImportModuleError('Import initial réservé au directeur', 403, 'FORBIDDEN');
    if (!(await this.repository.isInitialConfiguration())) {
      throw new ImportModuleError('Les imports élèves et professeurs sont fermés après la configuration initiale. La reprise est réservée au super administrateur.', 403, 'INITIAL_IMPORT_CLOSED');
    }
  }

  async assertLegacyImportAllowed(role: string) {
    await this.assertDirector(role);
    throw new ImportModuleError('Utilisez l’import historique de profils pendant la configuration initiale', 403, 'HISTORICAL_IMPORT_REQUIRED');
  }

  getProfile() { return this.repository.getActiveProfile(PROFILE_TYPE); }
  async duringInitialConfiguration<T>(operation: (database: TenantDb) => Promise<T>): Promise<T> {
    try { return await this.repository.withInitialConfiguration(operation); }
    catch (error) {
      if (error instanceof Error && error.message === 'Initial import closed') {
        throw new ImportModuleError('L’initialisation a été finalisée ; cet import est fermé', 403, 'INITIAL_IMPORT_CLOSED');
      }
      throw error;
    }
  }
  saveProfile(fields: MappingFieldDefinition[], actorUserId: string) {
    return this.repository.saveActiveProfile({ importType: PROFILE_TYPE, actorUserId, fields: validateHistoricalMapping(fields) });
  }

  private async parse(file: Buffer) {
    if (file.length > 10 * 1024 * 1024) throw new ImportModuleError('Fichier limité à 10 Mo', 400, 'IMPORT_FILE_TOO_LARGE');
    try { return await parseMappingWorkbook(file, { multiSheet: true, ignoreSheets: IGNORED_SHEETS }); }
    catch { throw new ImportModuleError('Fichier Excel invalide : vérifiez les feuilles et les en-têtes', 400, 'IMPORT_INVALID_FILE'); }
  }

  async analyze(file: Buffer, yearLabel: string) {
    const schoolYearLabel = historicalSchoolYearSchema.parse(yearLabel);
    const workbook = await this.parse(file);
    const profile = await this.getProfile();
    const fields = resolveHistoricalFields(workbook.headers, profile?.fields);
    const resolution = resolveMappingByHeaders(workbook.headers, fields);
    const missingTargets = HISTORICAL_STUDENT_TARGETS.filter((target) => target.required && !resolution.matched.some((field) => field.targetField === target.key)).map((target) => target.key);
    const validation = missingTargets.length ? null : validateHistoricalRows(workbook, fields);
    const mappingSaved = Boolean(profile) && fields.length === profile!.fields.length
      && fields.every((field) => profile!.fields.some((stored) => stored.targetField === field.targetField && normalizeMappingLabel(stored.sourceColumnLabel) === normalizeMappingLabel(field.sourceColumnLabel)));
    return { schoolYearLabel, headers: workbook.headers, rowCount: workbook.rows.length, profile, mappingSaved, matchedFields: resolution.matched,
      missingTargets, sampleRows: validation?.preview ?? [], validCount: validation?.rows.length ?? 0, errors: validation?.errors ?? [] };
  }

  async confirm(file: Buffer, actorUserId: string, yearLabel: string) {
    const schoolYearLabel = historicalSchoolYearSchema.parse(yearLabel);
    const workbook = await this.parse(file);
    const profile = await this.getProfile();
    if (!profile) throw new ImportModuleError('Enregistrez les correspondances avant l’import', 409, 'MAPPING_PROFILE_REQUIRED');
    const validation = validateHistoricalRows(workbook, profile.fields);
    let result;
    try { result = await this.repository.confirmRows(validation.rows, actorUserId, schoolYearLabel); }
    catch (error) {
      if (error instanceof Error && error.message === 'Initial import closed') {
        throw new ImportModuleError('L’initialisation a été finalisée ; cet import est fermé', 403, 'INITIAL_IMPORT_CLOSED');
      }
      throw error;
    }
    return { ...result, schoolYearLabel, totalRows: workbook.rows.length, errors: [...validation.errors, ...result.errors] };
  }

  template(): Promise<Buffer> {
    return readFile(path.resolve(process.cwd(), 'templates', 'students.xlsx'));
  }
}
