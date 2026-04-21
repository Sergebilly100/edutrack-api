import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import * as XLSX from 'xlsx';

import { generateUsername } from '../../shared/utils/username.js';

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

const DAY_MAP: Record<string, number> = {
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
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

const parseWorkbook = (
  fileBuffer: Buffer,
  params?: {
    mode?: 'single-sheet' | 'multi-sheet';
    ignoreSheets?: string[];
  }
): ParsedWorkbook => {
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

const parseSubjects = (value: string): string[] => {
  return value
    .split(',')
    .map((item) => normalizeCell(item))
    .filter((item) => item.length > 0);
};

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

  if (!isMonday(period.weekStart) || !isMonday(period.weekEnd) || period.weekStart > period.weekEnd) {
    throw new ImportModuleError(
      `Impossible de laisser une semaine sans EDT entre ${period.weekStart} et ${period.weekEnd}`,
      400,
      'IMPORT_INVALID_PERIOD_RANGE'
    );
  }

  const start = new Date(`${period.weekStart}T00:00:00.000Z`);
  const end = new Date(`${period.weekEnd}T00:00:00.000Z`);
  const diffMs = end.getTime() - start.getTime();
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

const toDiffItem = (input: DiffPreviewItem): DiffPreviewItem => input;

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
  return 'transaction' in db && typeof db.transaction === 'function';
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

export class ImportService {
  constructor(private readonly repository: ImportRepository = defaultImportRepository) {}

  async dryRun(
    type: ImportType,
    fileBuffer: Buffer,
    db: QueryExecutor,
    options?: {
      mode?: ImportMode;
      schedulePeriod?: SchedulePeriodInput;
    }
  ): Promise<DryRunReport> {
    const mode = options?.mode ?? 'merge';
    if (type === 'students') {
      return (await this.validateStudents(fileBuffer, db, mode)).report;
    }

    if (type === 'teachers') {
      return (await this.validateTeachers(fileBuffer, db, mode)).report;
    }

    return (await this.validateSchedule(fileBuffer, db, options?.schedulePeriod)).report;
  }

  async confirm(
    type: ImportType,
    fileBuffer: Buffer,
    db: QueryExecutor,
    options?: {
      mode?: ImportMode;
      schedulePeriod?: SchedulePeriodInput;
    }
  ): Promise<ConfirmReport> {
    const mode = options?.mode ?? 'merge';
    if (type === 'students') {
      const validation = await this.validateStudents(fileBuffer, db, mode);
      return this.confirmStudents(validation, db, mode);
    }

    if (type === 'teachers') {
      const validation = await this.validateTeachers(fileBuffer, db, mode);
      return this.confirmTeachers(validation, db, mode);
    }

    const validation = await this.validateSchedule(fileBuffer, db, options?.schedulePeriod);
    return this.confirmSchedule(validation, db, options?.schedulePeriod);
  }

  async listHistory(
    db: QueryExecutor,
    limit: number
  ): Promise<
    Array<{
      id: string;
      imported_at: string;
      type: ImportType;
      imported_count: number;
      updated_count: number;
    }>
  > {
    const rows = await this.repository.listImportHistory(db, limit);
    return rows.map((row) => ({
      id: row.id,
      imported_at: row.imported_at,
      type: row.import_type,
      imported_count: row.imported_count,
      updated_count: row.updated_count,
    }));
  }

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
      const rowKey = normalizeKey(`${className}::${firstName}::${lastName}`);
      const rowIdentity = normalizedMatricule ? `matricule::${normalizedMatricule}` : `name::${rowKey}`;

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
        errors.push(
          {
            ...makeError({
              row: line,
              column: 'Classe*',
              message: `Feuille '${sheetRow.sheetName}' ligne ${line} : classe introuvable`,
              value: className,
            }),
            sheet: sheetRow.sheetName,
          }
        );
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

      if (parentPhoneRaw && !IMPORT_PHONE_REGEX.test(parentPhoneRaw)) {
        errors.push(
          {
            ...makeError({
              row: line,
              column: 'Téléphone parent',
              message: 'Format invalide, attendu 225 suivi de 10 chiffres',
              value: parentPhoneRaw,
            }),
            sheet: sheetRow.sheetName,
          }
        );
      }

      if (parentPhone2Raw && !IMPORT_PHONE_REGEX.test(parentPhone2Raw)) {
        errors.push(
          {
            ...makeError({
              row: line,
              column: 'Téléphone parent 2',
              message: 'Format invalide, attendu 225 suivi de 10 chiffres',
              value: parentPhone2Raw,
            }),
            sheet: sheetRow.sheetName,
          }
        );
      }

      const hasRowError = errors.some((error) => error.row === line && error.sheet === sheetRow.sheetName);
      if (hasRowError) {
        return;
      }

      parsedIdentitySet.add(rowIdentity);
      validRows.push({
        matricule: matricule || null,
        firstName,
        lastName,
        className,
        birthDate,
        parentName,
        parentPhone: parentPhoneRaw || null,
        parentName2,
        parentPhone2: parentPhone2Raw || null,
      });

      const existing = normalizedMatricule
        ? existingByMatricule.get(normalizedMatricule) ?? existingByKey.get(rowKey)
        : existingByKey.get(rowKey);
      if (!existing) {
        toAdd.push(
          toDiffItem({
            key: rowIdentity,
            displayName: `${lastName} ${firstName} (${className})`,
          })
        );
        return;
      }

      const changes: DiffPreviewItem['changes'] = {};
      if ((existing.matricule ?? null) !== (matricule || null)) {
        changes.matricule = {
          before: existing.matricule,
          after: matricule || null,
        };
      }

      if ((existing.birthDate ?? null) !== (birthDate ?? null)) {
        changes.birthDate = {
          before: existing.birthDate ?? null,
          after: birthDate ?? null,
        };
      }

      if ((existing.parentName ?? null) !== (parentName ?? null)) {
        changes.parentName = {
          before: existing.parentName ?? null,
          after: parentName ?? null,
        };
      }

      if ((existing.parentPhone ?? null) !== (parentPhoneRaw || null)) {
        changes.parentPhone = {
          before: existing.parentPhone ?? null,
          after: parentPhoneRaw || null,
        };
      }

      if ((existing.parentName2 ?? null) !== (parentName2 ?? null)) {
        changes.parentName2 = {
          before: existing.parentName2 ?? null,
          after: parentName2 ?? null,
        };
      }

      if ((existing.parentPhone2 ?? null) !== (parentPhone2Raw || null)) {
        changes.parentPhone2 = {
          before: existing.parentPhone2 ?? null,
          after: parentPhone2Raw || null,
        };
      }

      if (!existing.isActive) {
        changes.isActive = { before: 'false', after: 'true' };
      }

      if (changes && Object.keys(changes).length > 0) {
        toUpdate.push(
          toDiffItem({
            key: rowIdentity,
            displayName: `${lastName} ${firstName} (${className})`,
            changes,
          })
        );
      }
    });

    const toDelete =
      importMode === 'replace'
        ? existingStudents
            .filter((item) => {
              const identity = item.matricule
                ? `matricule::${normalizeKey(item.matricule)}`
                : `name::${item.key}`;
              return !parsedIdentitySet.has(identity) && item.isActive;
            })
            .map((item) =>
              toDiffItem({
                key: item.key,
                displayName: `${item.lastName} ${item.firstName} (${item.className})`,
              })
            )
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

      const subjects = parseSubjects(subjectsRaw);
      if (subjects.length === 0) {
        errors.push(
          makeError({ row: line, column: 'Matières*', message: 'Au moins une matière requise' })
        );
      }

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

      const teacherKey = normalizeKey(fullName);
      const teacherIdentity = normalizedMatricule
        ? `matricule::${normalizedMatricule}`
        : `name::${teacherKey}`;
      parsedTeacherIdentitySet.add(teacherIdentity);

      const existing = existingByMatriculeMatch ?? existingByName.get(teacherKey);
      if (!existing) {
        toAdd.push(
          toDiffItem({
            key: teacherIdentity,
            displayName: fullName,
          })
        );
        return;
      }

      const changes: DiffPreviewItem['changes'] = {};
      if ((existing.matricule ?? null) !== (matricule || null)) {
        changes.matricule = {
          before: existing.matricule ?? null,
          after: matricule || null,
        };
      }

      if (existing.type !== (type as 'vacataire' | 'permanent')) {
        changes.type = { before: existing.type, after: type };
      }

      if (normalizeSubjectsForCompare(existing.subjects) !== normalizeSubjectsForCompare(subjects)) {
        changes.subjects = {
          before: existing.subjects.join(', '),
          after: subjects.join(', '),
        };
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
          after:
            type === 'permanent' && monthlySalary !== null ? String(monthlySalary) : null,
        };
      }

      if (!existing.isActive) {
        changes.isActive = { before: 'false', after: 'true' };
      }

      if (changes && Object.keys(changes).length > 0) {
        toUpdate.push(
          toDiffItem({
            key: teacherIdentity,
            displayName: fullName,
            changes,
          })
        );
      }
    });

    const toDelete =
      importMode === 'replace'
        ? existingTeachers
            .filter((teacher) => {
              const identity = teacher.matricule
                ? `matricule::${normalizeKey(teacher.matricule)}`
                : `name::${teacher.key}`;
              return !parsedTeacherIdentitySet.has(identity) && teacher.isActive;
            })
            .map((teacher) =>
              toDiffItem({
                key: teacher.key,
                displayName: teacher.name,
              })
            )
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

  private async validateSchedule(
    fileBuffer: Buffer,
    db: QueryExecutor,
    schedulePeriod?: SchedulePeriodInput
  ): Promise<ScheduleValidation> {
    const parsed = parseWorkbook(fileBuffer);
    ensureRequiredHeaders(parsed.rows, SCHEDULE_HEADERS);

    const period = validateSchedulePeriodInput(schedulePeriod);
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
    }

    const [classes, teacherDirectory, timeSlots] = await Promise.all([
      this.repository.listClasses(db),
      this.repository.listTeacherDirectory(db),
      this.repository.listTimeSlots(db),
    ]);

    const classesByName = new Map(classes.map((item) => [normalizeKey(item.name), item.id]));
    const slotsByLabel = new Map(timeSlots.map((item) => [normalizeKey(item.label), item.id]));
    const teachersByName = new Map<string, string[]>();
    for (const teacher of teacherDirectory) {
      const key = normalizeKey(teacher.name);
      const list = teachersByName.get(key) ?? [];
      list.push(teacher.teacher_id);
      teachersByName.set(key, list);
    }

    const errors: ImportError[] = [];
    const validRows: ScheduleImportRow[] = [];

    parsed.rows.forEach((sheetRow) => {
      const line = sheetRow.line;
      const teacherName = normalizeCell(sheetRow.values['Nom professeur*']);
      const className = normalizeCell(sheetRow.values['Classe*']);
      const subject = normalizeCell(sheetRow.values['Matière*']);
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

  private async confirmStudents(
    validation: StudentValidation,
    db: QueryExecutor,
    mode: ImportMode
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
        const importedIdentity = new Set(
          validation.rows.map((row) =>
            row.matricule
              ? `matricule::${normalizeKey(row.matricule)}`
              : `name::${normalizeKey(`${row.className}::${row.firstName}::${row.lastName}`)}`
          )
        );
        const toDeactivateIds = existing
          .filter((item) => {
            const identity = item.matricule
              ? `matricule::${normalizeKey(item.matricule)}`
              : `name::${item.key}`;
            return !importedIdentity.has(identity) && item.isActive;
          })
          .map((item) => item.id);
        deactivated = await this.repository.deactivateStudentsByIds(executor, toDeactivateIds);
      }

      await this.repository.createImportHistory(executor, {
        importType: 'students',
        importedCount: imported,
        updatedCount: updated,
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

    return runInTransaction(db, run);
  }

  private async confirmTeachers(
    validation: TeacherValidation,
    db: QueryExecutor,
    mode: ImportMode
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
        const importedIdentity = new Set(
          validation.rows.map((row) =>
            row.matricule
              ? `matricule::${normalizeKey(row.matricule)}`
              : `name::${normalizeKey(`${row.firstName} ${row.lastName}`)}`
          )
        );
        const toDeactivateUserIds = existing
          .filter((item) => {
            const identity = item.matricule
              ? `matricule::${normalizeKey(item.matricule)}`
              : `name::${item.key}`;
            return !importedIdentity.has(identity) && item.isActive;
          })
          .map((item) => item.userId);
        deactivated = await this.repository.deactivateTeachersByIds(executor, toDeactivateUserIds);
      }

      await this.repository.createImportHistory(executor, {
        importType: 'teachers',
        importedCount: imported,
        updatedCount: updated,
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

    return runInTransaction(db, run);
  }

  private async confirmSchedule(
    validation: ScheduleValidation,
    db: QueryExecutor,
    schedulePeriod?: SchedulePeriodInput
  ): Promise<ConfirmReport> {
    this.ensureNoValidationErrors(validation.report);
    const period = validateSchedulePeriodInput(schedulePeriod);
    const today = new Date().toISOString().slice(0, 10);
    const periodStart = period?.weekStart ?? today;
    const periodEnd = period?.weekEnd ?? periodStart;

    const [classes, teacherDirectory, timeSlots, rooms] = await Promise.all([
      this.repository.listClasses(db),
      this.repository.listTeacherDirectory(db),
      this.repository.listTimeSlots(db),
      this.repository.listRooms(db),
    ]);
    let schedulePeriodId: string;
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

    const resolveRoomId = async (
      executor: QueryExecutor,
      row: ScheduleImportRow
    ): Promise<string> => {
      const roomKey = normalizeKey(row.roomName);
      const known = roomIdByName.get(roomKey);
      if (known) {
        return known;
      }

      // Retry on the very unlikely qr_token uniqueness collision.
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

    const run = async (executor: QueryExecutor): Promise<ConfirmReport> => {
      let imported = 0;
      let updated = 0;

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

      await this.repository.createImportHistory(executor, {
        importType: 'schedule',
        importedCount: imported,
        updatedCount: updated,
      });

      return {
        imported,
        updated,
        errors: [],
        preview: validation.report.preview,
        importMode: 'merge',
      };
    };

    return runInTransaction(db, run);
  }
}

export const buildImportService = (): ImportService => new ImportService(defaultImportRepository);
