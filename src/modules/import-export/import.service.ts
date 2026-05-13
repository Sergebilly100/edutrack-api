import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import * as XLSX from 'xlsx';

import { emit } from '../../shared/events/event-bus.js';
import { generateUsername } from '../../shared/utils/username.js';
import {
  canonicalizeSubject,
  canonicalizeSubjectList,
} from '../../shared/utils/subject-normalization.js';

import {
  defaultImportRepository,
  type ImportRepository,
  type QueryExecutor,
  type TransactionalQueryExecutor,
} from './import.repository.js';
import type {
  ConfirmReport,
  DiffPreviewItem,
  DryRunReport,
  ImportError,
  ImportMode,
  ImportType,
  SchedulePeriodInput,
  ScheduleImportRow,
  StudentImportRow,
  TeacherImportRow,
} from './import.types.js';
import { IMPORT_PHONE_REGEX } from './import.types.js';

const STUDENTS_REQUIRED_HEADERS = ['Prénom*', 'Nom*'] as const;
const TEACHERS_REQUIRED_HEADERS = ['Nom*', 'Prénom*', 'Type*', 'Matières*'] as const;
const SCHEDULE_HEADERS = ['Nom professeur*', 'Classe*', 'Matière*', 'Jour*', 'Créneau*', 'Salle'] as const;

const PREVIEW_LIMIT = 5;
const STUDENT_IGNORE_SHEETS = ['README', 'readme', 'Info', 'INSTRUCTIONS', 'Salles (référence)'];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const DAY_MAP: Record<string, number> = {
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
};

const parseUtcDate = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

const formatUtcDate = (value: Date): string => value.toISOString().slice(0, 10);

const dayOfWeekFromDate = (date: Date): number => {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
};

const nextIsoDayOnOrAfter = (base: Date, dayOfWeek: number): Date => {
  const baseIso = dayOfWeekFromDate(base);
  const delta = (dayOfWeek - baseIso + 7) % 7;
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + delta);
  return next;
};

const hasFutureOccurrenceInPeriod = (input: {
  validFrom: string;
  validTo: string;
  dayOfWeek: number;
  startTime: string;
  now?: Date;
}): boolean => {
  const now = input.now ?? new Date();
  const nowDateIso = formatUtcDate(now);
  const baseDateIso = input.validFrom > nowDateIso ? input.validFrom : nowDateIso;
  const periodEnd = parseUtcDate(input.validTo);
  let candidate = nextIsoDayOnOrAfter(parseUtcDate(baseDateIso), input.dayOfWeek);

  while (candidate <= periodEnd) {
    const candidateIso = formatUtcDate(candidate);
    const candidateDateTime = new Date(`${candidateIso}T${input.startTime}.000Z`);
    if (candidateDateTime > now) {
      return true;
    }
    // Advance to the next occurrence without mutating the loop variable's shared state.
    const next = new Date(candidate);
    next.setUTCDate(next.getUTCDate() + 7);
    candidate = next;
  }

  return false;
};

export class ImportModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ImportModuleError';
  }
}

type ParsedWorkbookRow = {
  sheetName: string;
  line: number;
  values: Record<string, string>;
};

type ParsedWorkbook = {
  rows: ParsedWorkbookRow[];
};

type StudentValidation = {
  report: DryRunReport;
  rows: StudentImportRow[];
};

type TeacherValidation = {
  report: DryRunReport;
  rows: TeacherImportRow[];
};

type ScheduleValidation = {
  report: DryRunReport;
  rows: ScheduleImportRow[];
};

const normalizeCell = (value: unknown): string => {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
};

const makeError = (params: {
  row: number;
  column: string;
  message: string;
  value?: string;
}): ImportError => ({
  row: params.row,
  column: params.column,
  message: params.message,
  value: params.value ?? '',
});

const assertFileSizeWithinLimit = (fileBuffer: Buffer): void => {
  if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
    throw new ImportModuleError(
      `Le fichier dépasse la taille maximale autorisée (${MAX_FILE_SIZE_BYTES / 1024 / 1024} Mo)`,
      400,
      'IMPORT_FILE_TOO_LARGE'
    );
  }
};

const parseWorkbook = (
  fileBuffer: Buffer,
  params?: {
    mode?: 'single-sheet' | 'multi-sheet';
    ignoreSheets?: string[];
  }
): ParsedWorkbook => {
  assertFileSizeWithinLimit(fileBuffer);
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });

  if (workbook.SheetNames.length === 0) {
    throw new ImportModuleError('Le fichier Excel est vide', 400, 'IMPORT_EMPTY_FILE');
  }

  const mode = params?.mode ?? 'single-sheet';
  const ignoreSet = new Set((params?.ignoreSheets ?? []).map((value) => value.toLowerCase()));
  const selectedSheets =
    mode === 'single-sheet'
      ? workbook.SheetNames.slice(0, 1)
      : workbook.SheetNames.filter((name) => !ignoreSet.has(name.toLowerCase()));

  if (selectedSheets.length === 0) {
    throw new ImportModuleError(
      'Aucune feuille de données trouvée dans le fichier Excel.',
      400,
      'IMPORT_EMPTY_FILE'
    );
  }

  const rows: ParsedWorkbookRow[] = [];
  for (const sheetName of selectedSheets) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }

    const parsedRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: false,
    });

    parsedRows.forEach((row, index) => {
      const mapped: Record<string, string> = {};
      for (const [key, value] of Object.entries(row)) {
        mapped[String(key).trim()] = normalizeCell(value);
      }

      if (Object.values(mapped).every((value) => value.length === 0)) {
        return;
      }

      rows.push({
        sheetName,
        line: index + 2,
        values: mapped,
      });
    });
  }

  return { rows };
};

const ensureRequiredHeaders = (rows: ParsedWorkbookRow[], headers: readonly string[]): void => {
  const first = rows[0]?.values ?? {};
  const missing = headers.filter((header) => !(header in first));

  if (missing.length > 0) {
    throw new ImportModuleError(
      `Colonnes manquantes: ${missing.join(', ')}`,
      400,
      'IMPORT_MISSING_HEADERS'
    );
  }
};

const previewWorkbookRows = (rows: ParsedWorkbookRow[]): Record<string, string>[] => {
  return rows.slice(0, PREVIEW_LIMIT).map((row) => ({
    Feuille: row.sheetName,
    ...row.values,
  }));
};

const normalizeKey = (value: string): string => normalizeCell(value).toLowerCase();

const parseSubjects = (value: string): string[] =>
  value
    .split(',')
    .map((item) => normalizeCell(item))
    .filter((item) => item.length > 0);

const generateRoomQrToken = (): string => randomBytes(32).toString('hex');

const parseDateToIso = (value: string): string | null => {
  if (!value) {
    return null;
  }

  const normalized = normalizeCell(value);
  if (!normalized) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const slashMatch = normalized.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slashMatch) {
    const day = slashMatch[1].padStart(2, '0');
    const month = slashMatch[2].padStart(2, '0');
    const year = slashMatch[3];
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
};

const isMonday = (isoDate: string): boolean => {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return parsed.getUTCDay() === 1;
};

// validateSchedulePeriodInput est une fonction qui valide les paramètres de période d'import du planning, 
// en s'assurant que les dates sont au format ISO, que weekStart est un lundi, que weekEnd est un lundi ultérieur à weekStart, 
// et que la période couvre un nombre entier de semaines.
const validateSchedulePeriodInput = (period?: SchedulePeriodInput): SchedulePeriodInput | undefined => {
  if (!period) {
    return undefined;
  }

  if (!period.weekStart || !period.weekEnd) {
    throw new ImportModuleError(
      'Période EDT invalide: weekStart et weekEnd sont requis.',
      400,
      'IMPORT_INVALID_PERIOD'
    );
  }

  // Un EDT doit toujours couvrir au moins une semaine complète, pour éviter les cas où des cours seraient perdus faute de période suffisamment longue pour les accueillir.
  if (!isMonday(period.weekStart) || !isMonday(period.weekEnd) || period.weekStart >= period.weekEnd) {
    throw new ImportModuleError(
      `Impossible de laisser une semaine sans EDT entre ${period.weekStart} et ${period.weekEnd}`,
      400,
      'IMPORT_INVALID_PERIOD_RANGE'
    );
  }

  const start = new Date(`${period.weekStart}T00:00:00.000Z`);
  const end = new Date(`${period.weekEnd}T00:00:00.000Z`);
  const diffMs = end.getTime() - start.getTime();
  // La période doit être un multiple de 7 jours
  if (diffMs % (7 * 24 * 60 * 60 * 1000) !== 0) {
    throw new ImportModuleError(
      `Impossible de laisser une semaine sans EDT entre ${period.weekStart} et ${period.weekEnd}`,
      400,
      'IMPORT_INVALID_PERIOD_RANGE'
    );
  }

  return period;
};

const normalizeSubjectsForCompare = (subjects: string[]): string =>
  [...subjects]
    .map((item) => normalizeKey(item))
    .sort()
    .join(',');

// ---------------------------------------------------------------------------
// Identity key helpers — single source of truth for deduplication
// ---------------------------------------------------------------------------

// buildStudentIdentityKey construit une clé d'identité pour un étudiant à partir de ses données. 
// Si le matricule est présent, il est utilisé comme clé unique. Sinon, la combinaison du nom, prénom et classe est utilisée. 
// Cette clé est normalisée pour assurer une comparaison insensible à la casse et aux espaces.
const buildStudentIdentityKey = (params: {
  matricule: string | null;
  firstName: string;
  lastName: string;
  className: string;
}): string => {
  if (params.matricule) {
    return `matricule::${normalizeKey(params.matricule)}`;
  }
  return `name::${normalizeKey(`${params.className}::${params.firstName}::${params.lastName}`)}`;
};

// buildTeacherIdentityKey construit une clé d'identité pour un enseignant à partir de ses données.
const buildTeacherIdentityKey = (params: {
  matricule: string | null;
  firstName: string;
  lastName: string;
}): string => {
  if (params.matricule) {
    return `matricule::${normalizeKey(params.matricule)}`;
  }
  return `name::${normalizeKey(`${params.firstName} ${params.lastName}`)}`;
};

// ---------------------------------------------------------------------------

const resolveTeacherUsername = (
  params: {
    firstName: string;
    lastName: string;
    fullName: string;
  },
  existingByName: Map<string, string[]>,
  knownUsernames: string[]
): string | null => {
  const byName = existingByName.get(normalizeKey(params.fullName));
  if (byName && byName.length > 1) {
    return null;
  }

  if (byName && byName.length === 1) {
    return byName[0];
  }

  const username = generateUsername(params.lastName, params.firstName, knownUsernames);
  knownUsernames.push(username);
  return username;
};

const hasTransaction = (db: QueryExecutor): db is TransactionalQueryExecutor => {
  return 'transaction' in db && typeof (db as TransactionalQueryExecutor).transaction === 'function';
};

const runInTransaction = async <T>(
  db: QueryExecutor,
  run: (executor: QueryExecutor) => Promise<T>
): Promise<T> => {
  if (hasTransaction(db)) {
    return db.transaction(run);
  }

  return run(db);
};

// ---------------------------------------------------------------------------
// Row-level validation helpers
// ---------------------------------------------------------------------------

// validateStudentRow valide une ligne du fichier Excel pour les étudiants, en vérifiant la présence des données requises, 
// la validité des formats (date, téléphone), et en détectant les doublons de matricule à la fois dans le batch et par rapport à la base de données.
const validateStudentRow = (
  sheetRow: ParsedWorkbookRow,
  classesByName: Map<string, string>,
  existingByMatricule: Map<string, { id: string; key: string; matricule: string | null; firstName: string; lastName: string; className: string; birthDate: string | null; parentName: string | null; parentPhone: string | null; parentName2: string | null; parentPhone2: string | null; isActive: boolean }>,
  batchStudentMatricules: Map<string, number>,
  errors: ImportError[]
): {
  matricule: string | null;
  firstName: string;
  lastName: string;
  className: string;
  birthDate: string | null;
  parentName: string | null;
  parentPhone: string | null;
  parentName2: string | null;
  parentPhone2: string | null;
} | null => {
  const line = sheetRow.line;
  const matricule = normalizeCell(sheetRow.values['Matricule']);
  const firstName = normalizeCell(sheetRow.values['Prénom*']);
  const lastName = normalizeCell(sheetRow.values['Nom*']);
  const className = normalizeCell(sheetRow.values['Classe*']) || normalizeCell(sheetRow.sheetName);
  const birthDateRaw = normalizeCell(sheetRow.values['Date de naissance']);
  const birthDate = parseDateToIso(birthDateRaw);
  const parentName = normalizeCell(sheetRow.values['Nom parent']) || null;
  const parentPhoneRaw = normalizeCell(sheetRow.values['Téléphone parent']);
  const parentName2 = normalizeCell(sheetRow.values['Nom parent 2']) || null;
  const parentPhone2Raw = normalizeCell(sheetRow.values['Téléphone parent 2']);
  const normalizedMatricule = matricule ? normalizeKey(matricule) : null;

  if (normalizedMatricule) {
    const existingInBatch = batchStudentMatricules.get(normalizedMatricule);
    if (existingInBatch) {
      errors.push({
        ...makeError({
          row: line,
          column: 'Matricule',
          message: `Matricule dupliqué dans le fichier (déjà utilisé à la ligne ${existingInBatch})`,
          value: matricule,
        }),
        sheet: sheetRow.sheetName,
      });
    } else {
      batchStudentMatricules.set(normalizedMatricule, line);
    }
  }

  if (!firstName) {
    errors.push({
      ...makeError({ row: line, column: 'Prénom*', message: 'Prénom requis' }),
      sheet: sheetRow.sheetName,
    });
  }

  if (!lastName) {
    errors.push({
      ...makeError({ row: line, column: 'Nom*', message: 'Nom requis' }),
      sheet: sheetRow.sheetName,
    });
  }

  if (!className) {
    errors.push({
      ...makeError({ row: line, column: 'Classe*', message: 'Classe requise (ou nom de feuille)' }),
      sheet: sheetRow.sheetName,
    });
  } else if (!classesByName.has(normalizeKey(className))) {
    errors.push({
      ...makeError({
        row: line,
        column: 'Classe*',
        message: `Feuille '${sheetRow.sheetName}' ligne ${line} : classe introuvable`,
        value: className,
      }),
      sheet: sheetRow.sheetName,
    });
  }

  if (birthDateRaw && !birthDate) {
    errors.push({
      ...makeError({
        row: line,
        column: 'Date de naissance',
        message: 'Date invalide (formats acceptés: YYYY-MM-DD ou JJ/MM/AAAA)',
        value: birthDateRaw,
      }),
      sheet: sheetRow.sheetName,
    });
  }

  // le téléphone parent 1 est obligatoire, donc on génère une erreur s'il est absent ou invalide.
  if (parentPhoneRaw && !IMPORT_PHONE_REGEX.test(parentPhoneRaw)) {
    errors.push({
      ...makeError({
        row: line,
        column: 'Téléphone parent',
        message: 'Format invalide, attendu 225 suivi de 10 chiffres',
        value: parentPhoneRaw,
      }),
      sheet: sheetRow.sheetName,
    });
  }

  // contrairement au téléphone parent 1, le téléphone parent 2 est optionnel, donc on ne génère une erreur que s'il est présent mais invalide.
  if (parentPhone2Raw && !IMPORT_PHONE_REGEX.test(parentPhone2Raw)) {
    errors.push({
      ...makeError({
        row: line,
        column: 'Téléphone parent 2',
        message: 'Format invalide, attendu 225 suivi de 10 chiffres',
        value: parentPhone2Raw,
      }),
      sheet: sheetRow.sheetName,
    });
  }

  const hasRowError = errors.some((e) => e.row === line && e.sheet === sheetRow.sheetName);
  if (hasRowError) {
    return null;
  }

  return {
    matricule: matricule || null,
    firstName,
    lastName,
    className,
    birthDate,
    parentName,
    parentPhone: parentPhoneRaw || null,
    parentName2,
    parentPhone2: parentPhone2Raw || null,
  };
};

// ---------------------------------------------------------------------------

export class ImportService {
  constructor(private readonly repository: ImportRepository = defaultImportRepository) {}

  // dryRun effectue une validation des données du fichier Excel pour le type d'import spécifié, sans appliquer de changements en base.
  async dryRun(
    type: ImportType,
    fileBuffer: Buffer,
    db: QueryExecutor,
    options?: {
      mode?: ImportMode;
      schedulePeriod?: SchedulePeriodInput;
    }
  ): Promise<DryRunReport> { 
    // le service doit valider les données du fichier Excel pour le type d'import spécifié, en vérifiant la présence des colonnes requises, 
    // la validité des données (format de date, format de téléphone), et en comparant avec les données existantes dans la base pour détecter les ajouts, 
    // mises à jour et suppressions potentielles. Le rapport de validation doit inclure une liste d'erreurs détectées, ainsi qu'un aperçu des changements 
    // qui seraient appliqués en cas de confirmation de l'import.
    const mode = options?.mode ?? 'merge';
    if (type === 'students') {
      return (await this.validateStudents(fileBuffer, db, mode)).report;
    }

    if (type === 'teachers') {
      return (await this.validateTeachers(fileBuffer, db, mode)).report;
    }

    return (await this.validateSchedule(fileBuffer, db, options?.schedulePeriod)).report;
  }

  // la logique est plus complexe pour la confirmation d'import de planning, 
  // car elle doit gérer les conflits potentiels détectés lors du dry-run et s'assurer que 
  // l'utilisateur a bien pris connaissance de ces conflits avant de procéder à l'import effectif. 
  // C'est pourquoi la validation de la reconnaissance des conflits appartient au service et non au contrôleur.
  async confirm(
    type: ImportType,
    fileBuffer: Buffer,
    db: QueryExecutor,
    options?: {
      mode?: ImportMode;
      schedulePeriod?: SchedulePeriodInput;
      conflictAcknowledged?: boolean;
      tenantContext?: { tenantId: string; schemaName: string; actorUserId?: string; actorRole?: string };
    }
  ): Promise<ConfirmReport> {
    const mode = options?.mode ?? 'merge';
    // pour les étudiants, la confirmation d'import est nécessaire pour permettre à l'utilisateur de prendre connaissance des changements 
    // qui seront appliqués (ajouts, mises à jour, suppressions) et de confirmer qu'il souhaite procéder à ces changements.
    if (type === 'students') {
      const validation = await this.validateStudents(fileBuffer, db, mode);
      return this.confirmStudents(validation, db, mode, options?.tenantContext);
    }

    // pour les enseignants, la logique de confirmation est similaire à celle des étudiants, même si les conflits potentiels sont moins fréquents que pour les plannings.
    if (type === 'teachers') {
      const validation = await this.validateTeachers(fileBuffer, db, mode);
      return this.confirmTeachers(validation, db, mode, options?.tenantContext);
    }

    const validation = await this.validateSchedule(fileBuffer, db, options?.schedulePeriod);

    // le service doit vérifier que l'utilisateur a bien reconnu les conflits avant de procéder à l'import effectif, 
    // afin d'éviter les imports accidentels qui écraseraient des données existantes sans que l'utilisateur en ait conscience.
    const hasConflicts = Array.isArray(validation.report.conflicts) && validation.report.conflicts.length > 0;
    if (hasConflicts && !options?.conflictAcknowledged) {
      throw new ImportModuleError(
        'Conflits EDT détectés. Merci de confirmer le remplacement.',
        400,
        'IMPORT_CONFLICT_ACK_REQUIRED'
      );
    }

    return this.confirmSchedule(validation, db, options?.schedulePeriod, mode, options?.tenantContext);
  }

  // listHistory retourne les rapports d'import passés pour le tenant, avec pagination et filtres optionnels par mois et type d'import.
  async listHistory(
    db: QueryExecutor,
    filter: { limit: number; page: number; month?: string; type?: ImportType }
  ): Promise<{
      items: Array<{
        id: string;
        imported_at: string;
        type: ImportType;
        imported_count: number;
        updated_count: number;
        schedule_period?: string | null;
        imported_by: string | null;
        imported_by_name: string | null;
        imported_by_role: string | null;
      }>;
    total: number;
    page: number;
    totalPages: number;
  }> {
    const { items, total } = await this.repository.listImportHistory(db, filter);
    return {
      items: items.map((row) => ({
        id: row.id,
        imported_at: row.imported_at,
        type: row.import_type,
        imported_count: row.imported_count,
        updated_count: row.updated_count,
        schedule_period: row.schedule_period,
        imported_by: row.imported_by,
        imported_by_name: row.imported_by_name,
        imported_by_role: row.imported_by_role,
      })),
      total,
      page: filter.page,
      totalPages: Math.max(1, Math.ceil(total / filter.limit)),
    };
  }

  // validateStudents valide les données du fichier Excel pour les étudiants, en vérifiant la présence des colonnes requises, 
  // la validité des données (format de date, format de téléphone), et en comparant avec les données existantes dans la base pour 
  // détecter les ajouts, mises à jour et suppressions potentielles.
  private async validateStudents(
    fileBuffer: Buffer,
    db: QueryExecutor,
    importMode: ImportMode
  ): Promise<StudentValidation> {
    const parsed = parseWorkbook(fileBuffer, {
      mode: 'multi-sheet',
      ignoreSheets: STUDENT_IGNORE_SHEETS,
    });
    ensureRequiredHeaders(parsed.rows, STUDENTS_REQUIRED_HEADERS);

    const classes = await this.repository.listClasses(db);
    const classesByName = new Map(classes.map((item) => [normalizeKey(item.name), item.id]));
    const existingStudents = await this.repository.listExistingStudents(db);
    const existingByKey = new Map(existingStudents.map((item) => [item.key, item]));
    const existingByMatricule = new Map(
      existingStudents
        .filter((item) => item.matricule)
        .map((item) => [normalizeKey(item.matricule as string), item])
    );

    const errors: ImportError[] = [];
    const validRows: StudentImportRow[] = [];
    const parsedIdentitySet = new Set<string>();
    const batchStudentMatricules = new Map<string, number>();
    const toAdd: DiffPreviewItem[] = [];
    const toUpdate: DiffPreviewItem[] = [];

    parsed.rows.forEach((sheetRow) => {
      const fields = validateStudentRow(
        sheetRow,
        classesByName,
        existingByMatricule,
        batchStudentMatricules,
        errors
      );
      if (!fields) return;

      const identityKey = buildStudentIdentityKey(fields);
      parsedIdentitySet.add(identityKey);
      validRows.push(fields);

      const normalizedMatricule = fields.matricule ? normalizeKey(fields.matricule) : null;
      const rowKey = normalizeKey(`${fields.className}::${fields.firstName}::${fields.lastName}`);
      const existing = normalizedMatricule
        ? existingByMatricule.get(normalizedMatricule) ?? existingByKey.get(rowKey)
        : existingByKey.get(rowKey);

      if (!existing) {
        toAdd.push({ key: identityKey, displayName: `${fields.lastName} ${fields.firstName} (${fields.className})` });
        return;
      }

      const changes: DiffPreviewItem['changes'] = {};
      if ((existing.matricule ?? null) !== (fields.matricule ?? null)) {
        changes.matricule = { before: existing.matricule, after: fields.matricule };
      }
      if ((existing.birthDate ?? null) !== (fields.birthDate ?? null)) {
        changes.birthDate = { before: existing.birthDate ?? null, after: fields.birthDate ?? null };
      }
      if ((existing.parentName ?? null) !== (fields.parentName ?? null)) {
        changes.parentName = { before: existing.parentName ?? null, after: fields.parentName ?? null };
      }
      if ((existing.parentPhone ?? null) !== (fields.parentPhone ?? null)) {
        changes.parentPhone = { before: existing.parentPhone ?? null, after: fields.parentPhone ?? null };
      }
      if ((existing.parentName2 ?? null) !== (fields.parentName2 ?? null)) {
        changes.parentName2 = { before: existing.parentName2 ?? null, after: fields.parentName2 ?? null };
      }
      if ((existing.parentPhone2 ?? null) !== (fields.parentPhone2 ?? null)) {
        changes.parentPhone2 = { before: existing.parentPhone2 ?? null, after: fields.parentPhone2 ?? null };
      }
      if (!existing.isActive) {
        changes.isActive = { before: 'false', after: 'true' };
      }

      if (Object.keys(changes).length > 0) {
        toUpdate.push({ key: identityKey, displayName: `${fields.lastName} ${fields.firstName} (${fields.className})`, changes });
      }
    });

    const toDelete =
      importMode === 'replace'
        ? existingStudents
            .filter((item) => {
              const identity = buildStudentIdentityKey({
                matricule: item.matricule,
                firstName: item.firstName,
                lastName: item.lastName,
                className: item.className,
              });
              return !parsedIdentitySet.has(identity) && item.isActive;
            })
            .map((item) => ({
              key: item.key,
              displayName: `${item.lastName} ${item.firstName} (${item.className})`,
            }))
        : [];

    const unchanged = Math.max(0, validRows.length - toAdd.length - toUpdate.length);

    return {
      rows: validRows,
      report: {
        valid: validRows.length,
        errors,
        preview: previewWorkbookRows(parsed.rows),
        toAdd,
        toUpdate,
        toDelete,
        unchanged,
        importMode,
      },
    };
  }

  // validateTeachers valide les données du fichier Excel pour les enseignants, en vérifiant la présence des colonnes requises,
  private async validateTeachers(
    fileBuffer: Buffer,
    db: QueryExecutor,
    importMode: ImportMode
  ): Promise<TeacherValidation> {
    const parsed = parseWorkbook(fileBuffer);
    ensureRequiredHeaders(parsed.rows, TEACHERS_REQUIRED_HEADERS);

    const directory = await this.repository.listTeacherDirectory(db);
    const existingTeachers = await this.repository.listExistingTeachers(db);
    const existingByName = new Map(existingTeachers.map((item) => [normalizeKey(item.name), item]));
    const existingByMatricule = new Map(
      existingTeachers
        .filter((item) => item.matricule)
        .map((item) => [normalizeKey(item.matricule as string), item])
    );
    const subjectCatalog = new Set(
      existingTeachers.flatMap((item) => canonicalizeSubjectList(item.subjects))
    );
    const existingUsernames = directory.map((item) => item.username);
    const byName = new Map<string, string[]>();
    for (const item of directory) {
      const key = normalizeKey(item.name);
      const current = byName.get(key) ?? [];
      current.push(item.username);
      byName.set(key, current);
    }

    const errors: ImportError[] = [];
    const validRows: TeacherImportRow[] = [];
    const batchAssignedUsernames = new Set<string>();
    const parsedTeacherIdentitySet = new Set<string>();
    const batchTeacherMatricules = new Map<string, number>();
    const toAdd: DiffPreviewItem[] = [];
    const toUpdate: DiffPreviewItem[] = [];

    parsed.rows.forEach((sheetRow) => {
      const line = sheetRow.line;
      const matricule = normalizeCell(sheetRow.values['Matricule']);
      const lastName = normalizeCell(sheetRow.values['Nom*']);
      const firstName = normalizeCell(sheetRow.values['Prénom*']);
      const type = normalizeKey(sheetRow.values['Type*']);
      const subjectsRaw = normalizeCell(sheetRow.values['Matières*']);
      const hourlyRateRaw = normalizeCell(sheetRow.values['Taux horaire FCFA']);
      const monthlySalaryRaw = normalizeCell(sheetRow.values['Salaire mensuel FCFA']);
      const normalizedMatricule = matricule ? normalizeKey(matricule) : null;

      if (normalizedMatricule) {
        const existingInBatch = batchTeacherMatricules.get(normalizedMatricule);
        if (existingInBatch) {
          errors.push(
            makeError({
              row: line,
              column: 'Matricule',
              message: `Matricule dupliqué dans le fichier (déjà utilisé à la ligne ${existingInBatch})`,
              value: matricule,
            })
          );
        } else {
          batchTeacherMatricules.set(normalizedMatricule, line);
        }
      }

      if (!lastName) {
        errors.push(makeError({ row: line, column: 'Nom*', message: 'Nom requis' }));
      }

      if (!firstName) {
        errors.push(makeError({ row: line, column: 'Prénom*', message: 'Prénom requis' }));
      }

      if (type !== 'vacataire' && type !== 'permanent') {
        errors.push(
          makeError({
            row: line,
            column: 'Type*',
            message: 'Type invalide (vacataire|permanent)',
            value: normalizeCell(sheetRow.values['Type*']),
          })
        );
      }

      const subjects = canonicalizeSubjectList(
        parseSubjects(subjectsRaw).map((subject) => canonicalizeSubject(subject, subjectCatalog))
      );
      if (subjects.length === 0) {
        errors.push(
          makeError({ row: line, column: 'Matières*', message: 'Au moins une matière requise' })
        );
      }
      subjects.forEach((subject) => subjectCatalog.add(subject));

      let hourlyRate: number | null = null;
      if (hourlyRateRaw) {
        const parsedRate = Number(hourlyRateRaw);
        if (!Number.isInteger(parsedRate) || parsedRate < 0) {
          errors.push(
            makeError({
              row: line,
              column: 'Taux horaire FCFA',
              message: 'Taux horaire invalide',
              value: hourlyRateRaw,
            })
          );
        } else {
          hourlyRate = parsedRate;
        }
      }

      let monthlySalary: number | null = null;
      if (monthlySalaryRaw) {
        const parsedSalary = Number(monthlySalaryRaw);
        if (!Number.isInteger(parsedSalary) || parsedSalary < 0) {
          errors.push(
            makeError({
              row: line,
              column: 'Salaire mensuel FCFA',
              message: 'Salaire mensuel invalide',
              value: monthlySalaryRaw,
            })
          );
        } else {
          monthlySalary = parsedSalary;
        }
      }

      if (type === 'permanent' && monthlySalary === null) {
        errors.push(
          makeError({
            row: line,
            column: 'Salaire mensuel FCFA',
            message: 'Salaire mensuel requis pour un professeur permanent',
          })
        );
      }

      if (type === 'vacataire' && monthlySalary !== null) {
        errors.push(
          makeError({
            row: line,
            column: 'Salaire mensuel FCFA',
            message: 'Le salaire mensuel est réservé aux professeurs permanents',
            value: monthlySalaryRaw,
          })
        );
      }

      const fullName = `${firstName} ${lastName}`.trim();
      const existingByMatriculeMatch = normalizedMatricule
        ? existingByMatricule.get(normalizedMatricule)
        : null;
      const username =
        existingByMatriculeMatch?.username ??
        resolveTeacherUsername({ firstName, lastName, fullName }, byName, existingUsernames);

      if (!username) {
        errors.push(
          makeError({
            row: line,
            column: 'Nom*',
            message: 'Nom enseignant ambigu, plusieurs profils existants',
            value: fullName,
          })
        );
      }

      const hasRowError = errors.some((error) => error.row === line);
      if (hasRowError || !username) {
        return;
      }

      let resolvedUsername = username;
      if (batchAssignedUsernames.has(resolvedUsername)) {
        resolvedUsername = generateUsername(lastName, firstName, existingUsernames);
        existingUsernames.push(resolvedUsername);
      }

      batchAssignedUsernames.add(resolvedUsername);

      validRows.push({
        matricule: matricule || null,
        lastName,
        firstName,
        type: type as 'vacataire' | 'permanent',
        subjects,
        hourlyRate,
        monthlySalary: type === 'permanent' ? monthlySalary : null,
        username: resolvedUsername,
      });

      const teacherIdentity = buildTeacherIdentityKey({ matricule: matricule || null, firstName, lastName });
      parsedTeacherIdentitySet.add(teacherIdentity);

      const existing = existingByMatriculeMatch ?? existingByName.get(normalizeKey(fullName));
      if (!existing) {
        toAdd.push({ key: teacherIdentity, displayName: fullName });
        return;
      }

      const changes: DiffPreviewItem['changes'] = {};
      if ((existing.matricule ?? null) !== (matricule || null)) {
        changes.matricule = { before: existing.matricule ?? null, after: matricule || null };
      }
      if (existing.type !== (type as 'vacataire' | 'permanent')) {
        changes.type = { before: existing.type, after: type };
      }
      if (normalizeSubjectsForCompare(existing.subjects) !== normalizeSubjectsForCompare(subjects)) {
        changes.subjects = { before: existing.subjects.join(', '), after: subjects.join(', ') };
      }
      if ((existing.hourlyRate ?? null) !== (hourlyRate ?? null)) {
        changes.hourlyRate = {
          before: existing.hourlyRate === null ? null : String(existing.hourlyRate),
          after: hourlyRate === null ? null : String(hourlyRate),
        };
      }
      if ((existing.monthlySalary ?? null) !== ((type === 'permanent' ? monthlySalary : null) ?? null)) {
        changes.monthlySalary = {
          before: existing.monthlySalary === null ? null : String(existing.monthlySalary),
          after: type === 'permanent' && monthlySalary !== null ? String(monthlySalary) : null,
        };
      }
      if (!existing.isActive) {
        changes.isActive = { before: 'false', after: 'true' };
      }

      if (Object.keys(changes).length > 0) {
        toUpdate.push({ key: teacherIdentity, displayName: fullName, changes });
      }
    });

    const toDelete =
      importMode === 'replace'
        ? existingTeachers
            .filter((teacher) => {
              const identity = buildTeacherIdentityKey({
                matricule: teacher.matricule,
                firstName: teacher.name.split(' ')[0] ?? '',
                lastName: teacher.name.split(' ').slice(1).join(' '),
              });
              return !parsedTeacherIdentitySet.has(identity) && teacher.isActive;
            })
            .map((teacher) => ({ key: teacher.key, displayName: teacher.name }))
        : [];

    const unchanged = Math.max(0, validRows.length - toAdd.length - toUpdate.length);

    return {
      rows: validRows,
      report: {
        valid: validRows.length,
        errors,
        preview: previewWorkbookRows(parsed.rows),
        toAdd,
        toUpdate,
        toDelete,
        unchanged,
        importMode,
      },
    };
  }

  // validateSchedule valide les données du fichier Excel pour le planning, en vérifiant la présence des colonnes requises, 
  // la validité des données (correspondance avec les classes, enseignants et créneaux horaires existants en base), 
  // et en détectant les conflits potentiels avec les données de planning existantes pour la période concernée.
  private async validateSchedule(
    fileBuffer: Buffer,
    db: QueryExecutor,
    schedulePeriod?: SchedulePeriodInput
  ): Promise<ScheduleValidation> {
    const parsed = parseWorkbook(fileBuffer);
    ensureRequiredHeaders(parsed.rows, SCHEDULE_HEADERS);

    const period = validateSchedulePeriodInput(schedulePeriod);
    let resolvedPeriodBounds: { validFrom: string; validTo: string } | null = null;
    if (!period) {
      const today = new Date().toISOString().slice(0, 10);
      const activePeriodId = await this.repository.findActiveSchedulePeriodId(db, today);
      if (!activePeriodId) {
        throw new ImportModuleError(
          'Aucune période EDT active trouvée. Sélectionnez une période avant import.',
          400,
          'IMPORT_NO_ACTIVE_PERIOD'
        );
      }
      const activePeriod = await this.repository.findSchedulePeriodById(db, activePeriodId);
      if (!activePeriod) {
        throw new ImportModuleError(
          'Période EDT active introuvable.',
          400,
          'IMPORT_NO_ACTIVE_PERIOD'
        );
      }
      resolvedPeriodBounds = {
        validFrom: activePeriod.valid_from,
        validTo: activePeriod.valid_to,
      };
    } else {
      resolvedPeriodBounds = {
        validFrom: period.weekStart,
        validTo: period.weekEnd,
      };
    }

    const [classes, teacherDirectory, timeSlots] = await Promise.all([
      this.repository.listClasses(db),
      this.repository.listTeacherDirectory(db),
      this.repository.listTimeSlots(db),
    ]);

    const classesByName = new Map(classes.map((item) => [normalizeKey(item.name), item.id]));
    const slotsByLabel = new Map(
      timeSlots.map((item) => [
        normalizeKey(item.label),
        { id: item.id, startTime: item.start_time, endTime: item.end_time },
      ])
    );
    const teachersByName = new Map<string, string[]>();
    for (const teacher of teacherDirectory) {
      const key = normalizeKey(teacher.name);
      const list = teachersByName.get(key) ?? [];
      list.push(teacher.teacher_id);
      teachersByName.set(key, list);
    }
    const subjectCatalog = new Set(
      teacherDirectory.flatMap((teacher) => canonicalizeSubjectList(teacher.subjects ?? []))
    );

    const errors: ImportError[] = [];
    const validRows: ScheduleImportRow[] = [];

    parsed.rows.forEach((sheetRow) => {
      const line = sheetRow.line;
      const teacherName = normalizeCell(sheetRow.values['Nom professeur*']);
      const className = normalizeCell(sheetRow.values['Classe*']);
      const subject = canonicalizeSubject(normalizeCell(sheetRow.values['Matière*']), subjectCatalog);
      const day = normalizeKey(sheetRow.values['Jour*']);
      const slotLabel = normalizeCell(sheetRow.values['Créneau*']);
      const roomName = normalizeCell(sheetRow.values['Salle']);
      const roomBuilding = normalizeCell(sheetRow.values['Bâtiment salle']) || null;
      const roomCapacityRaw = normalizeCell(sheetRow.values['Capacité salle']);
      let roomCapacity: number | null = null;

      if (roomCapacityRaw) {
        const parsedCapacity = Number(roomCapacityRaw);
        if (!Number.isInteger(parsedCapacity) || parsedCapacity < 0) {
          errors.push(
            makeError({
              row: line,
              column: 'Capacité salle',
              message: 'Capacité salle invalide (entier positif attendu)',
              value: roomCapacityRaw,
            })
          );
        } else {
          roomCapacity = parsedCapacity;
        }
      }

      if (!teacherName) {
        errors.push(makeError({ row: line, column: 'Nom professeur*', message: 'Professeur requis' }));
      }

      const teacherMatches = teachersByName.get(normalizeKey(teacherName)) ?? [];
      if (teacherName && teacherMatches.length === 0) {
        errors.push(
          makeError({
            row: line,
            column: 'Nom professeur*',
            message: 'Professeur introuvable en base',
            value: teacherName,
          })
        );
      } else if (teacherMatches.length > 1) {
        errors.push(
          makeError({
            row: line,
            column: 'Nom professeur*',
            message: 'Professeur ambigu (plusieurs correspondances)',
            value: teacherName,
          })
        );
      }

      if (!className) {
        errors.push(makeError({ row: line, column: 'Classe*', message: 'Classe requise' }));
      } else if (!classesByName.has(normalizeKey(className))) {
        errors.push(
          makeError({
            row: line,
            column: 'Classe*',
            message: 'Classe introuvable en base',
            value: className,
          })
        );
      }

      if (!subject) {
        errors.push(makeError({ row: line, column: 'Matière*', message: 'Matière requise' }));
      }

      if (!day || !(day in DAY_MAP)) {
        errors.push(
          makeError({
            row: line,
            column: 'Jour*',
            message: 'Jour invalide (Lundi..Samedi)',
            value: normalizeCell(sheetRow.values['Jour*']),
          })
        );
      }

      if (!slotLabel) {
        errors.push(makeError({ row: line, column: 'Créneau*', message: 'Créneau requis' }));
      } else if (!slotsByLabel.has(normalizeKey(slotLabel))) {
        errors.push(
          makeError({
            row: line,
            column: 'Créneau*',
            message: 'Créneau introuvable en base',
            value: slotLabel,
          })
        );
      }

      if (!roomName) {
        errors.push(
          makeError({
            row: line,
            column: 'Salle',
            message: 'Salle requise',
            value: roomName,
          })
        );
      }

      if (resolvedPeriodBounds && day in DAY_MAP && slotLabel) {
        const slotInfo = slotsByLabel.get(normalizeKey(slotLabel));
        if (slotInfo) {
          const hasFuture = hasFutureOccurrenceInPeriod({
            validFrom: resolvedPeriodBounds.validFrom,
            validTo: resolvedPeriodBounds.validTo,
            dayOfWeek: DAY_MAP[day],
            startTime: slotInfo.startTime,
          });
          if (!hasFuture) {
            errors.push(
              makeError({
                row: line,
                column: 'Jour*',
                message: "Impossible d'ajouter un créneau sur une date/heure passée",
                value: `${sheetRow.values['Jour*']} ${slotLabel}`,
              })
            );
          }
        }
      }

      const hasRowError = errors.some((error) => error.row === line);
      if (hasRowError) {
        return;
      }

      validRows.push({
        teacherName,
        className,
        subject,
        dayOfWeek: DAY_MAP[day],
        slotLabel,
        roomName,
        roomBuilding,
        roomCapacity,
      });
      subjectCatalog.add(subject);
    });

    let conflicts: DryRunReport['conflicts'] = [];
    if (period) {
      const overlapping = await this.repository.findOverlappingSchedulePeriods(
        db,
        period.weekStart,
        period.weekEnd
      );
      conflicts = overlapping.map((item) => ({
        periodName: item.name,
        weekStart: item.valid_from,
        weekEnd: item.valid_to,
        message: `L'EDT "${item.name}" est déjà défini pour la semaine du ${item.valid_from}`,
      }));
    }

    return {
      rows: validRows,
      report: {
        valid: validRows.length,
        errors,
        preview: previewWorkbookRows(parsed.rows),
        conflicts,
      },
    };
  }

  private ensureNoValidationErrors(report: DryRunReport): void {
    if (report.errors.length === 0) {
      return;
    }

    throw new ImportModuleError('Validation import échouée', 400, 'IMPORT_VALIDATION_FAILED', report);
  }

  // confirmStudents et confirmTeachers sont responsables de l'exécution de l'import effectif des élève et des profs dans la base de données, 
  // en appliquant les ajouts, mises à jour et suppressions détectés lors de la validation, 
  // et en enregistrant un historique de l'import. Ils émettent également un événement une fois 
  // l'import terminé pour permettre à d'autres parties du système de réagir à ce changement (ex: rafraîchir des caches).
  private async confirmStudents(
    validation: StudentValidation,
    db: QueryExecutor,
    mode: ImportMode,
    tenantContext?: { tenantId: string; schemaName: string; actorUserId?: string; actorRole?: string }
  ): Promise<ConfirmReport> {
    this.ensureNoValidationErrors(validation.report);

    const run = async (executor: QueryExecutor): Promise<ConfirmReport> => {
      let imported = 0;
      let updated = 0;
      let deactivated = 0;

      for (const row of validation.rows) {
        const result = await this.repository.upsertStudent(executor, row);
        if (result === 'inserted') {
          imported += 1;
        } else {
          updated += 1;
        }
      }

      if (mode === 'replace') {
        const existing = await this.repository.listExistingStudents(executor);
        const importedIdentitySet = new Set(
          validation.rows.map((row) => buildStudentIdentityKey(row))
        );
        const toDeactivateIds = existing
          .filter((item) => {
            const identity = buildStudentIdentityKey({
              matricule: item.matricule,
              firstName: item.firstName,
              lastName: item.lastName,
              className: item.className,
            });
            return !importedIdentitySet.has(identity) && item.isActive;
          })
          .map((item) => item.id);
        deactivated = await this.repository.deactivateStudentsByIds(executor, toDeactivateIds);
      }

      // c'est ici que createImportHistory est appelé pour enregistrer un historique de l'import dans la base de données, avec des informations sur le nombre d'enregistrements 
      // importés, mis à jour, désactivés, ainsi que l'utilisateur qui a effectué l'import et son rôle.
      await this.repository.createImportHistory(executor, {
        importType: 'students',
        importedCount: imported,
        updatedCount: updated,
        schedulePeriod: null,
        importedBy: tenantContext?.actorUserId,
        importedByRole: tenantContext?.actorRole,
      });

      return {
        imported,
        updated,
        errors: [],
        preview: validation.report.preview,
        deactivated,
        importMode: mode,
      };
    };

    // runInTransaction est utilisé pour exécuter l'ensemble du processus d'import dans une transaction de base de données, 
    // ce qui garantit que toutes les opérations d'import sont atomiques : si une erreur survient à n'importe quelle étape du processus, la transaction sera annulée et 
    // la base de données restera dans un état cohérent.
    const report = await runInTransaction(db, run);

    if (tenantContext) {
      emit('import.completed', {
        tenantId: tenantContext.tenantId,
        schemaName: tenantContext.schemaName,
        importType: 'students',
        importedCount: report.imported,
        updatedCount: report.updated,
        deactivatedCount: report.deactivated ?? 0,
      });
    }

    return report;
  }

  private async confirmTeachers(
    validation: TeacherValidation,
    db: QueryExecutor,
    mode: ImportMode,
    tenantContext?: { tenantId: string; schemaName: string; actorUserId?: string; actorRole?: string }
  ): Promise<ConfirmReport> {
    this.ensureNoValidationErrors(validation.report);

    const defaultTeacherPassword = process.env.IMPORT_TEACHER_DEFAULT_PASSWORD;
    if (!defaultTeacherPassword) {
      throw new ImportModuleError(
        'Variable IMPORT_TEACHER_DEFAULT_PASSWORD non configurée',
        500,
        'IMPORT_MISSING_CONFIG'
      );
    }
    const passwordHash = await argon2.hash(defaultTeacherPassword);

    const run = async (executor: QueryExecutor): Promise<ConfirmReport> => {
      let imported = 0;
      let updated = 0;
      let deactivated = 0;

      for (const row of validation.rows) {
        const displayName = `${row.firstName} ${row.lastName}`.trim();
        const result = await this.repository.upsertTeacher(executor, row, {
          displayName,
          passwordHash,
        });

        if (result === 'inserted') {
          imported += 1;
        } else {
          updated += 1;
        }
      }

      if (mode === 'replace') {
        const existing = await this.repository.listExistingTeachers(executor);
        const importedIdentitySet = new Set(
          validation.rows.map((row) => buildTeacherIdentityKey(row))
        );
        const toDeactivateUserIds = existing
          .filter((item) => {
            const identity = buildTeacherIdentityKey({
              matricule: item.matricule,
              firstName: item.name.split(' ')[0] ?? '',
              lastName: item.name.split(' ').slice(1).join(' '),
            });
            return !importedIdentitySet.has(identity) && item.isActive;
          })
          .map((item) => item.userId);
        deactivated = await this.repository.deactivateTeachersByIds(executor, toDeactivateUserIds);
      }

      await this.repository.createImportHistory(executor, {
        importType: 'teachers',
        importedCount: imported,
        updatedCount: updated,
        schedulePeriod: null,
        importedBy: tenantContext?.actorUserId,
        importedByRole: tenantContext?.actorRole,
      });

      return {
        imported,
        updated,
        errors: [],
        preview: validation.report.preview,
        deactivated,
        importMode: mode,
      };
    };

    const report = await runInTransaction(db, run);

    if (tenantContext) {
      emit('import.completed', {
        tenantId: tenantContext.tenantId,
        schemaName: tenantContext.schemaName,
        importType: 'teachers',
        importedCount: report.imported,
        updatedCount: report.updated,
        deactivatedCount: report.deactivated ?? 0,
      });
    }

    return report;
  }

  // confirmSchedule est responsable de l'exécution de l'import effectif du planning dans la base de données, en appliquant les ajouts et mises à jour détectés lors de la validation,
  // et en enregistrant un historique de l'import. Il gère également la création automatique des salles si elles n'existent pas, 
  // et vérifie les références aux classes, enseignants, créneaux horaires pour s'assurer qu'elles sont valides avant de procéder à l'import.
  private async confirmSchedule(
    validation: ScheduleValidation,
    db: QueryExecutor,
    schedulePeriod?: SchedulePeriodInput,
    importMode: ImportMode = 'merge',
    tenantContext?: { tenantId: string; schemaName: string; actorUserId?: string; actorRole?: string }
  ): Promise<ConfirmReport> {
    this.ensureNoValidationErrors(validation.report);
    const period = validateSchedulePeriodInput(schedulePeriod);
    const today = new Date().toISOString().slice(0, 10);
    const periodStart = period?.weekStart ?? today;
    const periodEnd = period?.weekEnd ?? periodStart;

    // on charge en parallèle les données de référence nécessaires à l'import du planning : classes, enseignants, créneaux horaires, salles.
    const [classes, teacherDirectory, timeSlots, rooms] = await Promise.all([
      this.repository.listClasses(db),
      this.repository.listTeacherDirectory(db),
      this.repository.listTimeSlots(db),
      this.repository.listRooms(db),
    ]);

    let schedulePeriodId: string;
    // si une période est spécifiée dans les paramètres d'import, on la crée ou la récupère en base, sinon on utilise la période active actuelle.
    if (period) {
      schedulePeriodId = await this.repository.findOrCreateSchedulePeriod(db, {
        name: `Import EDT ${periodStart} - ${periodEnd}`,
        validFrom: periodStart,
        validTo: periodEnd,
      });
    } else {
      const activePeriodId = await this.repository.findActiveSchedulePeriodId(db, today);
      if (!activePeriodId) {
        throw new ImportModuleError(
          'Aucune période EDT active trouvée. Sélectionnez une période avant import.',
          400,
          'IMPORT_NO_ACTIVE_PERIOD'
        );
      }
      schedulePeriodId = activePeriodId;
    }

    const classIdByName = new Map(classes.map((item) => [normalizeKey(item.name), item.id]));
    const slotIdByLabel = new Map(timeSlots.map((item) => [normalizeKey(item.label), item.id]));
    const roomIdByName = new Map(rooms.map((item) => [normalizeKey(item.name), item.id]));

    // resolveRoomId est une fonction utilitaire qui prend un nom de salle et tente de trouver l'ID correspondant en base. Si la salle n'existe pas, 
    // elle tente de la créer automatiquement.
    const resolveRoomId = async (
      executor: QueryExecutor,
      row: ScheduleImportRow
    ): Promise<string> => {
      const roomKey = normalizeKey(row.roomName);
      const known = roomIdByName.get(roomKey);
      if (known) {
        return known;
      }

      // c'est ici que l'upsert de la salle est effectué, avec une logique de retry pour gérer les éventuelles conditions de concurrence 
      // (si plusieurs lignes du planning font référence à la même salle qui n'existe pas encore, elles tenteront de la créer en même temps).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const created = await this.repository.upsertRoom(executor, {
            name: row.roomName,
            qrToken: generateRoomQrToken(),
            building: row.roomBuilding,
            capacity: row.roomCapacity,
          });
          roomIdByName.set(roomKey, created.id);
          return created.id;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === '23505' && attempt < 2) {
            continue;
          }
          throw error;
        }
      }

      throw new ImportModuleError('Impossible de créer la salle automatiquement', 500, 'IMPORT_ROOM_CREATE_FAILED');
    };

    const teacherByName = new Map<string, string>();
    for (const teacher of teacherDirectory) {
      teacherByName.set(normalizeKey(teacher.name), teacher.teacher_id);
    }

    // run est la fonction qui contient la logique principale d'import du planning. Elle itère sur les lignes validées du fichier Excel,
    // résout les références aux classes, enseignants, créneaux horaires, salles, et effectue les opérations d'insertion ou de mise à jour dans la base de données.
    const run = async (executor: QueryExecutor): Promise<ConfirmReport> => {
      let imported = 0;
      let updated = 0;
      const upsertedScheduleIds: string[] = [];

      // on parcourt les lignes validées du planning, et pour chacune d'elles, on tente de résoudre les références à la classe, l'enseignant, le créneau horaire et la salle.
      for (const row of validation.rows) {
        const classId = classIdByName.get(normalizeKey(row.className));
        const teacherId = teacherByName.get(normalizeKey(row.teacherName));
        const timeSlotId = slotIdByLabel.get(normalizeKey(row.slotLabel));
        const roomId = await resolveRoomId(executor, row);

        if (!classId || !teacherId || !timeSlotId || !roomId) {
          throw new ImportModuleError(
            'Références invalides détectées au moment de la confirmation',
            400,
            'IMPORT_REFERENCE_ERROR'
          );
        }

        // upsertSchedule est une fonction qui effectue l'insertion ou la mise à jour d'un créneau de planning dans la base de données, 
        // en fonction de l'existence ou non d'un créneau similaire pour la même période, classe, enseignant, créneau horaire.
        const result = await this.repository.upsertSchedule(executor, row, {
          schedulePeriodId,
          teacherId,
          classId,
          timeSlotId,
          roomId,
        });

        if (result === 'inserted') {
          imported += 1;
        } else {
          updated += 1;
        }
      }

      // Mode replace: deactivate schedules of this period that were not in the import file
      if (importMode === 'replace') {
        await this.repository.deactivateSchedulesByPeriodExcluding(
          executor,
          schedulePeriodId,
          upsertedScheduleIds
        );
      }

      // c'est ici que createImportHistory est appelé pour enregistrer un historique de l'import du planning dans la base de données, 
      // avec des informations sur le nombre d'enregistrements importés, mis à jour, ainsi que l'utilisateur qui a effectué l'import et son rôle.
      await this.repository.createImportHistory(executor, {
        importType: 'schedule',
        importedCount: imported,
        updatedCount: updated,
        schedulePeriod: schedulePeriod?.weekStart && schedulePeriod?.weekEnd
          ? `${schedulePeriod.weekStart} - ${schedulePeriod.weekEnd}`
          : null,
        importedBy: tenantContext?.actorUserId,
        importedByRole: tenantContext?.actorRole,
      });

      return {
        imported,
        updated,
        errors: [],
        preview: validation.report.preview,
        importMode,
      };
    };

    const report = await runInTransaction(db, run);

    if (tenantContext) {
      emit('import.completed', {
        tenantId: tenantContext.tenantId,
        schemaName: tenantContext.schemaName,
        importType: 'schedule',
        importedCount: report.imported,
        updatedCount: report.updated,
        deactivatedCount: 0,
      });
    }

    return report;
  }
}

export const buildImportService = (): ImportService => new ImportService(defaultImportRepository);
