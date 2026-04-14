import argon2 from 'argon2';
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
  DryRunReport,
  ImportError,
  ImportType,
  ScheduleImportRow,
  StudentImportRow,
  TeacherImportRow,
} from './import.types.js';
import { IMPORT_PHONE_REGEX } from './import.types.js';

const STUDENTS_HEADERS = ['Prénom*', 'Nom*', 'Classe*', 'Téléphone parent'] as const;
const TEACHERS_HEADERS = ['Nom*', 'Prénom*', 'Type*', 'Matières*', 'Taux horaire FCFA'] as const;
const SCHEDULE_HEADERS = ['Nom professeur*', 'Classe*', 'Matière*', 'Jour*', 'Créneau*', 'Salle'] as const;

const PREVIEW_LIMIT = 5;

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

type ParsedSheet = {
  rows: Record<string, string>[];
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

const parseWorkbook = (fileBuffer: Buffer): ParsedSheet => {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    throw new ImportModuleError('Le fichier Excel est vide', 400, 'IMPORT_EMPTY_FILE');
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new ImportModuleError('Impossible de lire la feuille Excel', 400, 'IMPORT_INVALID_FILE');
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
  });

  const normalized = rows.map((row) => {
    const mapped: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      mapped[String(key).trim()] = normalizeCell(value);
    }
    return mapped;
  });

  return { rows: normalized };
};

const ensureRequiredHeaders = (
  rows: Record<string, string>[],
  headers: readonly string[]
): void => {
  const first = rows[0] ?? {};
  const missing = headers.filter((header) => !(header in first));

  if (missing.length > 0) {
    throw new ImportModuleError(
      `Colonnes manquantes: ${missing.join(', ')}`,
      400,
      'IMPORT_MISSING_HEADERS'
    );
  }
};

const previewRows = (rows: Record<string, string>[]): Record<string, string>[] => {
  return rows.slice(0, PREVIEW_LIMIT);
};

const normalizeKey = (value: string): string => normalizeCell(value).toLowerCase();

const parseSubjects = (value: string): string[] => {
  return value
    .split(',')
    .map((item) => normalizeCell(item))
    .filter((item) => item.length > 0);
};

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
    db: QueryExecutor
  ): Promise<DryRunReport> {
    if (type === 'students') {
      return (await this.validateStudents(fileBuffer, db)).report;
    }

    if (type === 'teachers') {
      return (await this.validateTeachers(fileBuffer, db)).report;
    }

    return (await this.validateSchedule(fileBuffer, db)).report;
  }

  async confirm(
    type: ImportType,
    fileBuffer: Buffer,
    db: QueryExecutor
  ): Promise<ConfirmReport> {
    if (type === 'students') {
      const validation = await this.validateStudents(fileBuffer, db);
      return this.confirmStudents(validation, db);
    }

    if (type === 'teachers') {
      const validation = await this.validateTeachers(fileBuffer, db);
      return this.confirmTeachers(validation, db);
    }

    const validation = await this.validateSchedule(fileBuffer, db);
    return this.confirmSchedule(validation, db);
  }

  private async validateStudents(fileBuffer: Buffer, db: QueryExecutor): Promise<StudentValidation> {
    const parsed = parseWorkbook(fileBuffer);
    ensureRequiredHeaders(parsed.rows, STUDENTS_HEADERS);

    const classes = await this.repository.listClasses(db);
    const classesByName = new Map(classes.map((item) => [normalizeKey(item.name), item.id]));

    const errors: ImportError[] = [];
    const validRows: StudentImportRow[] = [];

    parsed.rows.forEach((row, index) => {
      const line = index + 2;
      const firstName = normalizeCell(row['Prénom*']);
      const lastName = normalizeCell(row['Nom*']);
      const className = normalizeCell(row['Classe*']);
      const parentPhoneRaw = normalizeCell(row['Téléphone parent']);

      if (!firstName) {
        errors.push(makeError({ row: line, column: 'Prénom*', message: 'Prénom requis' }));
      }

      if (!lastName) {
        errors.push(makeError({ row: line, column: 'Nom*', message: 'Nom requis' }));
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

      if (parentPhoneRaw && !IMPORT_PHONE_REGEX.test(parentPhoneRaw)) {
        errors.push(
          makeError({
            row: line,
            column: 'Téléphone parent',
            message: 'Format invalide, attendu 225XXXXXXXXXX',
            value: parentPhoneRaw,
          })
        );
      }

      const hasRowError = errors.some((error) => error.row === line);
      if (hasRowError) {
        return;
      }

      validRows.push({
        firstName,
        lastName,
        className,
        parentPhone: parentPhoneRaw || null,
      });
    });

    return {
      rows: validRows,
      report: {
        valid: validRows.length,
        errors,
        preview: previewRows(parsed.rows),
      },
    };
  }

  private async validateTeachers(fileBuffer: Buffer, db: QueryExecutor): Promise<TeacherValidation> {
    const parsed = parseWorkbook(fileBuffer);
    ensureRequiredHeaders(parsed.rows, TEACHERS_HEADERS);

    const directory = await this.repository.listTeacherDirectory(db);
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

    parsed.rows.forEach((row, index) => {
      const line = index + 2;
      const lastName = normalizeCell(row['Nom*']);
      const firstName = normalizeCell(row['Prénom*']);
      const type = normalizeKey(row['Type*']);
      const subjectsRaw = normalizeCell(row['Matières*']);
      const hourlyRateRaw = normalizeCell(row['Taux horaire FCFA']);

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
            value: normalizeCell(row['Type*']),
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

      const fullName = `${firstName} ${lastName}`.trim();
      const username = resolveTeacherUsername(
        { firstName, lastName, fullName },
        byName,
        existingUsernames
      );

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
        lastName,
        firstName,
        type: type as 'vacataire' | 'permanent',
        subjects,
        hourlyRate,
        username: resolvedUsername,
      });
    });

    return {
      rows: validRows,
      report: {
        valid: validRows.length,
        errors,
        preview: previewRows(parsed.rows),
      },
    };
  }

  private async validateSchedule(fileBuffer: Buffer, db: QueryExecutor): Promise<ScheduleValidation> {
    const parsed = parseWorkbook(fileBuffer);
    ensureRequiredHeaders(parsed.rows, SCHEDULE_HEADERS);

    const [classes, teacherDirectory, timeSlots, rooms, activePeriodId] = await Promise.all([
      this.repository.listClasses(db),
      this.repository.listTeacherDirectory(db),
      this.repository.listTimeSlots(db),
      this.repository.listRooms(db),
      this.repository.findActiveSchedulePeriodId(db, new Date().toISOString().slice(0, 10)),
    ]);

    const classesByName = new Map(classes.map((item) => [normalizeKey(item.name), item.id]));
    const slotsByLabel = new Map(timeSlots.map((item) => [normalizeKey(item.label), item.id]));
    const roomsByName = new Map(rooms.map((item) => [normalizeKey(item.name), item.id]));

    if (!activePeriodId) {
      throw new ImportModuleError(
        'Aucune période active couvrant la date du jour',
        400,
        'IMPORT_NO_ACTIVE_PERIOD'
      );
    }

    const teachersByName = new Map<string, string[]>();
    for (const teacher of teacherDirectory) {
      const key = normalizeKey(teacher.name);
      const list = teachersByName.get(key) ?? [];
      list.push(teacher.teacher_id);
      teachersByName.set(key, list);
    }

    const errors: ImportError[] = [];
    const validRows: ScheduleImportRow[] = [];

    parsed.rows.forEach((row, index) => {
      const line = index + 2;
      const teacherName = normalizeCell(row['Nom professeur*']);
      const className = normalizeCell(row['Classe*']);
      const subject = normalizeCell(row['Matière*']);
      const day = normalizeKey(row['Jour*']);
      const slotLabel = normalizeCell(row['Créneau*']);
      const roomName = normalizeCell(row['Salle']);

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
            value: normalizeCell(row['Jour*']),
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
      } else if (!roomsByName.has(normalizeKey(roomName))) {
        errors.push(
          makeError({
            row: line,
            column: 'Salle',
            message: 'Salle introuvable en base',
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
      });
    });

    return {
      rows: validRows,
      report: {
        valid: validRows.length,
        errors,
        preview: previewRows(parsed.rows),
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
    db: QueryExecutor
  ): Promise<ConfirmReport> {
    this.ensureNoValidationErrors(validation.report);

    const run = async (executor: QueryExecutor): Promise<ConfirmReport> => {
      let imported = 0;
      let updated = 0;

      for (const row of validation.rows) {
        const result = await this.repository.upsertStudent(executor, row);
        if (result === 'inserted') {
          imported += 1;
        } else {
          updated += 1;
        }
      }

      return {
        imported,
        updated,
        errors: [],
        preview: validation.report.preview,
      };
    };

    return runInTransaction(db, run);
  }

  private async confirmTeachers(
    validation: TeacherValidation,
    db: QueryExecutor
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

      return {
        imported,
        updated,
        errors: [],
        preview: validation.report.preview,
      };
    };

    return runInTransaction(db, run);
  }

  private async confirmSchedule(
    validation: ScheduleValidation,
    db: QueryExecutor
  ): Promise<ConfirmReport> {
    this.ensureNoValidationErrors(validation.report);

    const [classes, teacherDirectory, timeSlots, rooms, schedulePeriodId] = await Promise.all([
      this.repository.listClasses(db),
      this.repository.listTeacherDirectory(db),
      this.repository.listTimeSlots(db),
      this.repository.listRooms(db),
      this.repository.findActiveSchedulePeriodId(db, new Date().toISOString().slice(0, 10)),
    ]);

    if (!schedulePeriodId) {
      throw new ImportModuleError(
        'Aucune période active disponible pour importer les cours',
        400,
        'IMPORT_NO_ACTIVE_PERIOD'
      );
    }

    const classIdByName = new Map(classes.map((item) => [normalizeKey(item.name), item.id]));
    const slotIdByLabel = new Map(timeSlots.map((item) => [normalizeKey(item.label), item.id]));
    const roomIdByName = new Map(rooms.map((item) => [normalizeKey(item.name), item.id]));

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
        const roomId = roomIdByName.get(normalizeKey(row.roomName));

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

      return {
        imported,
        updated,
        errors: [],
        preview: validation.report.preview,
      };
    };

    return runInTransaction(db, run);
  }
}

export const buildImportService = (): ImportService => new ImportService(defaultImportRepository);
