import ExcelJS from 'exceljs';
import { normalizeMappingLabel, resolveMappingByHeaders, translateMappedValue, type MappingFieldDefinition } from '../../shared/import-mapping/engine.js';
import { parseMappingWorkbook, type ParsedMappingWorkbook } from '../../shared/import-mapping/workbook.js';
import { ImportModuleError } from './import.service.js';
import { HistoricalStudentsRepository } from './historical-students.repository.js';
import { HISTORICAL_STUDENT_TARGETS, historicalStudentRowSchema, type HistoricalStudentError, type HistoricalStudentRow } from './historical-students.types.js';

const PROFILE_TYPE = 'historical_students';

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
    throw new ImportModuleError('Associez le matricule, le nom et le prénom', 400, 'MAPPING_REQUIRED_FIELDS_MISSING');
  }
  return fields.map((field) => ({ ...field, isRequired: HISTORICAL_STUDENT_TARGETS.find((target) => target.key === field.targetField)!.required }));
};

export const validateHistoricalRows = (workbook: ParsedMappingWorkbook, fields: MappingFieldDefinition[]) => {
  const resolution = resolveMappingByHeaders(workbook.headers, validateHistoricalMapping(fields));
  if (resolution.missingRequiredTargets.length) {
    throw new ImportModuleError(`Colonnes introuvables : ${resolution.missingRequiredTargets.join(', ')}`, 422, 'MAPPING_COLUMNS_MISSING');
  }
  const rows: HistoricalStudentRow[] = [];
  const errors: HistoricalStudentError[] = [];
  const matricules = new Set<string>();
  const preview: Array<{ rowNumber: number; values: Record<string, string> }> = [];
  for (const row of workbook.rows) {
    const values = Object.fromEntries(HISTORICAL_STUDENT_TARGETS.map((target) => {
      const field = resolution.matched.find((candidate) => candidate.targetField === target.key);
      const raw = field ? String(row.values[field.sourceColumnLabel] ?? '').trim() : '';
      return [target.key, field ? translateMappedValue(field, raw) ?? raw : raw];
    }));
    if (preview.length < 10) preview.push({ rowNumber: row.rowNumber, values });
    const parsed = historicalStudentRowSchema.safeParse(values);
    if (!parsed.success) {
      errors.push(...parsed.error.issues.map((issue) => ({ rowNumber: row.rowNumber, field: String(issue.path[0]), reason: issue.message })));
      continue;
    }
    const key = normalizeMappingLabel(parsed.data.matricule);
    if (matricules.has(key)) {
      errors.push({ rowNumber: row.rowNumber, field: 'matricule', reason: 'Matricule dupliqué dans le fichier' });
      continue;
    }
    matricules.add(key);
    rows.push({ ...parsed.data, rowNumber: row.rowNumber });
  }
  return { rows, errors, preview, resolution };
};

export class HistoricalStudentsService {
  constructor(private readonly repository: HistoricalStudentsRepository) {}

  async assertDirector(role: string) {
    if (role !== 'director') throw new ImportModuleError('Import historique réservé au directeur', 403, 'FORBIDDEN');
  }

  async assertLegacyImportAllowed(role: string) {
    if (role === 'director' && await this.repository.isInitialConfiguration()) {
      throw new ImportModuleError('Utilisez l’import historique de profils pendant la configuration initiale', 403, 'HISTORICAL_IMPORT_REQUIRED');
    }
  }

  getProfile() { return this.repository.getActiveProfile(PROFILE_TYPE); }
  saveProfile(fields: MappingFieldDefinition[], actorUserId: string) {
    return this.repository.saveActiveProfile({ importType: PROFILE_TYPE, actorUserId, fields: validateHistoricalMapping(fields) });
  }

  private async parse(file: Buffer) {
    if (file.length > 10 * 1024 * 1024) throw new ImportModuleError('Fichier limité à 10 Mo', 400, 'IMPORT_FILE_TOO_LARGE');
    try { return await parseMappingWorkbook(file); }
    catch { throw new ImportModuleError('Fichier Excel invalide : vérifiez la feuille et les en-têtes', 400, 'IMPORT_INVALID_FILE'); }
  }

  async analyze(file: Buffer) {
    const workbook = await this.parse(file);
    const profile = await this.getProfile();
    const fields = profile?.fields ?? HISTORICAL_STUDENT_TARGETS.flatMap((target) => {
      const header = workbook.headers.find((value) => normalizeMappingLabel(value) === normalizeMappingLabel(target.label));
      return header ? [{ sourceColumnLabel: header, targetField: target.key, isRequired: target.required, translations: [] }] : [];
    });
    const resolution = resolveMappingByHeaders(workbook.headers, fields);
    const missingTargets = HISTORICAL_STUDENT_TARGETS.filter((target) => target.required && !resolution.matched.some((field) => field.targetField === target.key)).map((target) => target.key);
    const validation = missingTargets.length ? null : validateHistoricalRows(workbook, fields);
    return { headers: workbook.headers, rowCount: workbook.rows.length, profile, matchedFields: resolution.matched,
      missingTargets, sampleRows: validation?.preview ?? [], validCount: validation?.rows.length ?? 0, errors: validation?.errors ?? [] };
  }

  async confirm(file: Buffer, actorUserId: string) {
    const workbook = await this.parse(file);
    const profile = await this.getProfile();
    if (!profile) throw new ImportModuleError('Enregistrez les correspondances avant l’import', 409, 'MAPPING_PROFILE_REQUIRED');
    const validation = validateHistoricalRows(workbook, profile.fields);
    const result = await this.repository.confirmRows(validation.rows, actorUserId);
    return { ...result, totalRows: workbook.rows.length, errors: [...validation.errors, ...result.errors] };
  }

  async template(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Profils historiques');
    sheet.addRow(HISTORICAL_STUDENT_TARGETS.map((target) => target.label));
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
}
