import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';

import { ImportModuleError, ImportService } from '../../src/modules/import-export/import.service.js';

const repository = {
  listClasses: vi.fn(),
  listTeacherDirectory: vi.fn(),
  listRooms: vi.fn(),
  listTimeSlots: vi.fn(),
  findOrCreateTimeSlot: vi.fn(),
  findActiveSchedulePeriodId: vi.fn(),
  findSchedulePeriodById: vi.fn(),
  findOverlappingSchedulePeriods: vi.fn(),
  findOrCreateSchedulePeriod: vi.fn(),
  listExistingStudents: vi.fn(),
  deactivateStudentsByIds: vi.fn(),
  listExistingTeachers: vi.fn(),
  deactivateTeachersByIds: vi.fn(),
  upsertStudent: vi.fn(),
  upsertTeacher: vi.fn(),
  upsertSchedule: vi.fn(),
  deactivateSchedulesByPeriodExcluding: vi.fn(),
  createImportHistory: vi.fn(),
  listImportHistory: vi.fn(),
};

const db = {
  execute: vi.fn(),
  transaction: vi.fn(<T>(fn: (tx: typeof db) => Promise<T>) => fn(db)),
};

const fillSheet = (sheet: ExcelJS.Worksheet, rows: Record<string, string>[]): void => {
  if (rows.length === 0) return;
  const headers = Array.from(
    rows.reduce<Set<string>>((acc, row) => {
      for (const key of Object.keys(row)) acc.add(key);
      return acc;
    }, new Set<string>())
  );
  sheet.columns = headers.map((header) => ({ header, key: header }));
  for (const row of rows) {
    sheet.addRow(row);
  }
};

const toWorkbookBuffer = async (rows: Record<string, string>[], sheetName = 'Sheet1'): Promise<Buffer> => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName);
  fillSheet(sheet, rows);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
};

const toMultiSheetBuffer = async (
  sheets: { name: string; rows: Record<string, string>[] }[]
): Promise<Buffer> => {
  const wb = new ExcelJS.Workbook();
  for (const { name, rows } of sheets) {
    const sheet = wb.addWorksheet(name);
    fillSheet(sheet, rows);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
};

beforeEach(() => {
  vi.clearAllMocks();
  // shouldAdvanceTime=true permet à exceljs (qui utilise setImmediate) de continuer
  // à tourner pendant que setSystemTime fige uniquement les wall-clock checks.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-04-01T08:00:00.000Z'));
  process.env.IMPORT_TEACHER_DEFAULT_PASSWORD = 'edutrack2024';

  repository.listClasses.mockResolvedValue([
    { id: 'class-1', name: '3ème A' },
    { id: 'class-2', name: 'Terminale D1' },
  ]);
  repository.listTeacherDirectory.mockResolvedValue([
    {
      teacher_id: 'teacher-1',
      user_id: 'user-1',
      name: 'Ibrahim Diallo',
      username: 'diallo.ibra',
      subjects: ['Mathématiques'],
    },
  ]);
  repository.listRooms.mockResolvedValue([{ id: 'room-1', name: 'Salle A1' }]);
  repository.listTimeSlots.mockResolvedValue([
    {
      id: 'slot-1',
      label: '7h30 - 9h00',
      start_time: '07:30:00',
      end_time: '09:00:00',
    },
  ]);
  repository.findOrCreateTimeSlot.mockResolvedValue({
    id: 'slot-created',
    label: '09:00 – 10:30',
    start_time: '09:00:00',
    end_time: '10:30:00',
  });
  repository.findActiveSchedulePeriodId.mockResolvedValue('period-1');
  repository.findSchedulePeriodById.mockResolvedValue({
    id: 'period-1',
    valid_from: '2026-04-01',
    valid_to: '2026-04-30',
  });
  repository.findOverlappingSchedulePeriods.mockResolvedValue([]);
  repository.findOrCreateSchedulePeriod.mockResolvedValue('period-1');
  repository.listExistingStudents.mockResolvedValue([]);
  repository.deactivateStudentsByIds.mockResolvedValue(0);
  repository.listExistingTeachers.mockResolvedValue([]);
  repository.deactivateTeachersByIds.mockResolvedValue(0);
  repository.upsertStudent.mockResolvedValue({ result: 'inserted' });
  repository.upsertTeacher.mockResolvedValue('inserted');
  repository.upsertSchedule.mockResolvedValue({ result: 'inserted', id: 'schedule-new' });
  repository.deactivateSchedulesByPeriodExcluding.mockResolvedValue(0);
  repository.createImportHistory.mockResolvedValue(undefined);
  repository.listImportHistory.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Students - dry-run
// ---------------------------------------------------------------------------

describe('import.service - students dry-run', () => {
  it('20 lignes valides → valid=20, errors=[], preview=5', async () => {
    const service = new ImportService(repository);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      'Prénom*': `Prenom${i + 1}`,
      'Nom*': `Nom${i + 1}`,
      'Classe*': '3ème A',
      'Téléphone parent': `2250700000${String(i + 1).padStart(3, '0')}`,
    }));

    const report = await service.dryRun('students', await toWorkbookBuffer(rows), db);

    expect(report.valid).toBe(20);
    expect(report.errors).toHaveLength(0);
    expect(report.preview).toHaveLength(5);
  });

  it('fichier sans colonnes requises → IMPORT_MISSING_HEADERS', async () => {
    const service = new ImportService(repository);
    const rows = [{ Prenom: 'Awa', Nom: 'Kouassi', Classe: '3ème A' }];

    await expect(service.dryRun('students', await toWorkbookBuffer(rows), db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_MISSING_HEADERS',
      statusCode: 400,
    });
  });

  it('lignes malformées → erreurs précises avec numéros de lignes', async () => {
    const service = new ImportService(repository);
    const rows = [
      { 'Prénom*': '', 'Nom*': 'Nom1', 'Classe*': '3ème A', 'Téléphone parent': '2250700000001' },
      { 'Prénom*': 'Awa', 'Nom*': 'Nom2', 'Classe*': 'Classe inconnue', 'Téléphone parent': '2250700000002' },
      { 'Prénom*': 'Yao', 'Nom*': 'Nom3', 'Classe*': '3ème A', 'Téléphone parent': '0700000000' },
    ];

    const report = await service.dryRun('students', await toWorkbookBuffer(rows), db);

    expect(report.valid).toBe(0);
    expect(report.errors).toHaveLength(3);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 2, column: 'Prénom*' }),
        expect.objectContaining({ row: 3, column: 'Classe*' }),
        expect.objectContaining({ row: 4, column: 'Téléphone parent' }),
      ])
    );
  });

  it('feuilles ignorées (README, Salles référence) ne génèrent pas d\'erreurs de headers', async () => {
    const service = new ImportService(repository);
    const buf = await toMultiSheetBuffer([
      { name: 'README', rows: [{ Note: 'Documentation' }] },
      { name: 'Salles (référence)', rows: [{ Salle: 'A1' }] },
      { name: '3ème A', rows: [{ 'Prénom*': 'Awa', 'Nom*': 'Bah', 'Classe*': '3ème A' }] },
    ]);

    const report = await service.dryRun('students', buf, db);

    expect(report.valid).toBe(1);
    expect(report.errors).toHaveLength(0);
  });

  it('fichier trop grand → IMPORT_FILE_TOO_LARGE', async () => {
    const service = new ImportService(repository);
    const hugeBuf = Buffer.alloc(11 * 1024 * 1024);

    await expect(service.dryRun('students', hugeBuf, db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_FILE_TOO_LARGE',
      statusCode: 400,
    });
  });

  it('mode replace → toDelete contient les élèves absents du fichier', async () => {
    repository.listExistingStudents.mockResolvedValue([
      {
        id: 'old-student',
        key: '3ème a::ancien::eleve',
        matricule: null,
        firstName: 'Ancien',
        lastName: 'Eleve',
        className: '3ème A',
        birthDate: null,
        parentName: null,
        parentPhone: null,
        parentName2: null,
        parentPhone2: null,
        isActive: true,
      },
    ]);
    const service = new ImportService(repository);
    const rows = [{ 'Prénom*': 'Awa', 'Nom*': 'Bah', 'Classe*': '3ème A' }];

    const report = await service.dryRun('students', await toWorkbookBuffer(rows), db, { mode: 'replace' });

    expect(report.toDelete).toHaveLength(1);
    expect(report.toDelete?.[0]?.displayName).toContain('Ancien');
  });
});

// ---------------------------------------------------------------------------
// Students - confirm
// ---------------------------------------------------------------------------

describe('import.service - students confirm', () => {
  it('fournit des identifiants temporaires au repository sans déclencher de SMS', async () => {
    const createParentCredentials = vi.fn().mockResolvedValue({
      plainPassword: 'ABCD234567',
      passwordHash: 'argon-hash',
    });
    repository.upsertStudent.mockImplementationOnce(async (_db, _row, factory) => {
      await factory();
      return {
        result: 'inserted',
        createdParent: {
          parentId: 'parent-1',
          fullName: 'Parent Awa',
          phone: '2250700000001',
        },
      };
    });
    const service = new ImportService(repository, createParentCredentials);
    const rows = [
      {
        'Prénom*': 'Awa',
        'Nom*': 'Kouassi',
        'Classe*': '3ème A',
        'Nom parent': 'Parent Awa',
        'Téléphone parent': '2250700000001',
      },
    ];

    const report = await service.confirm('students', await toWorkbookBuffer(rows), db);

    expect(report.imported).toBe(1);
    expect(report.pendingParentAccess).toEqual([
      {
        parentId: 'parent-1',
        fullName: 'Parent Awa',
        phone: '2250700000001',
      },
    ]);
    expect(createParentCredentials).toHaveBeenCalledOnce();
    expect(repository.upsertStudent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentName: 'Parent Awa', parentPhone: '2250700000001' }),
      expect.any(Function)
    );
  });

  it('20 lignes valides → imported=20, upsertStudent appelé 20 fois', async () => {
    const service = new ImportService(repository);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      'Prénom*': `Prenom${i + 1}`,
      'Nom*': `Nom${i + 1}`,
      'Classe*': '3ème A',
      'Téléphone parent': '',
    }));

    const report = await service.confirm('students', await toWorkbookBuffer(rows), db);

    expect(report.imported).toBe(20);
    expect(report.updated).toBe(0);
    expect(report.errors).toHaveLength(0);
    expect(repository.upsertStudent).toHaveBeenCalledTimes(20);
  });

  it('ne retourne qu’une fois un parent créé et partagé par plusieurs élèves', async () => {
    const createdParent = {
      parentId: 'parent-shared',
      fullName: 'Parent commun',
      phone: '2250700000009',
    };
    repository.upsertStudent
      .mockResolvedValueOnce({ result: 'inserted', createdParent })
      .mockResolvedValueOnce({ result: 'inserted' });
    const service = new ImportService(repository);
    const rows = [
      {
        'Prénom*': 'Awa',
        'Nom*': 'Kouassi',
        'Classe*': '3ème A',
        'Nom parent': createdParent.fullName,
        'Téléphone parent': createdParent.phone,
      },
      {
        'Prénom*': 'Yao',
        'Nom*': 'Kouassi',
        'Classe*': '3ème A',
        'Nom parent': createdParent.fullName,
        'Téléphone parent': createdParent.phone,
      },
    ];

    const report = await service.confirm('students', await toWorkbookBuffer(rows), db);

    expect(report.pendingParentAccess).toEqual([createdParent]);
  });

  it('invalide → IMPORT_VALIDATION_FAILED, aucun write DB', async () => {
    const service = new ImportService(repository);
    const rows = [{ 'Prénom*': '', 'Nom*': 'Nom1', 'Classe*': '3ème A', 'Téléphone parent': '' }];

    await expect(service.confirm('students', await toWorkbookBuffer(rows), db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_VALIDATION_FAILED',
      statusCode: 400,
    });

    expect(repository.upsertStudent).not.toHaveBeenCalled();
  });

  it('mode replace → deactivateStudentsByIds appelé avec les IDs absents', async () => {
    repository.listExistingStudents
      .mockResolvedValueOnce([]) // appel dans validateStudents
      .mockResolvedValueOnce([  // appel dans confirmStudents (replace branch)
        {
          id: 'old-id',
          key: '3ème a::ancien::eleve',
          matricule: null,
          firstName: 'Ancien',
          lastName: 'Eleve',
          className: '3ème A',
          birthDate: null,
          parentName: null,
          parentPhone: null,
          parentName2: null,
          parentPhone2: null,
          isActive: true,
        },
      ]);

    const service = new ImportService(repository);
    const rows = [{ 'Prénom*': 'Nouveau', 'Nom*': 'Eleve', 'Classe*': '3ème A' }];

    const report = await service.confirm('students', await toWorkbookBuffer(rows), db, { mode: 'replace' });

    expect(report.imported).toBe(1);
    expect(repository.deactivateStudentsByIds).toHaveBeenCalledWith(
      expect.anything(),
      ['old-id']
    );
  });
});

// ---------------------------------------------------------------------------
// Teachers - dry-run
// ---------------------------------------------------------------------------

describe('import.service - teachers dry-run', () => {
  it('5 lignes valides vacataire → valid=5, errors=[]', async () => {
    repository.listTeacherDirectory.mockResolvedValueOnce([]);
    const service = new ImportService(repository);

    const rows = Array.from({ length: 5 }, (_, i) => ({
      'Nom*': `Diallo${i + 1}`,
      'Prénom*': `Ibrahim${i + 1}`,
      'Type*': 'vacataire',
      'Matières*': 'Mathématiques, Physique',
      'Taux horaire FCFA': '5000',
    }));

    const report = await service.dryRun('teachers', await toWorkbookBuffer(rows), db);

    expect(report.valid).toBe(5);
    expect(report.errors).toHaveLength(0);
    expect(report.preview).toHaveLength(5);
  });

  it('collision username même fichier → 2 rows valides avec usernames distincts', async () => {
    repository.listTeacherDirectory.mockResolvedValueOnce([]);
    const service = new ImportService(repository);

    const rows = [
      { 'Nom*': 'Diallo', 'Prénom*': 'Ibrahim', 'Type*': 'vacataire', 'Matières*': 'Mathématiques', 'Taux horaire FCFA': '5000' },
      { 'Nom*': 'Diallo', 'Prénom*': 'Ibrahim', 'Type*': 'vacataire', 'Matières*': 'Physique', 'Taux horaire FCFA': '4500' },
    ];

    const dryRun = await service.dryRun('teachers', await toWorkbookBuffer(rows), db);
    expect(dryRun.valid).toBe(2);
    expect(dryRun.errors).toHaveLength(0);
  });

  it('prof ambigu (plusieurs correspondances en base) → erreur colonne Nom*', async () => {
    // fullName is built as "${firstName} ${lastName}" = "Ibrahim Diallo"
    repository.listTeacherDirectory.mockResolvedValueOnce([
      { teacher_id: 'teacher-1', user_id: 'user-1', name: 'Ibrahim Diallo', username: 'diallo.ibra', subjects: [] },
      { teacher_id: 'teacher-2', user_id: 'user-2', name: 'Ibrahim Diallo', username: 'diallo.ibra2', subjects: [] },
    ]);
    const service = new ImportService(repository);

    const rows = [
      { 'Nom*': 'Diallo', 'Prénom*': 'Ibrahim', 'Type*': 'vacataire', 'Matières*': 'Mathématiques', 'Taux horaire FCFA': '5000' },
    ];

    const report = await service.dryRun('teachers', await toWorkbookBuffer(rows), db);
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: 'Nom*', message: expect.stringContaining('ambigu') })])
    );
  });

  it('permanent sans salaire mensuel → erreur', async () => {
    repository.listTeacherDirectory.mockResolvedValueOnce([]);
    const service = new ImportService(repository);

    const rows = [
      { 'Nom*': 'Bah', 'Prénom*': 'Mamadou', 'Type*': 'permanent', 'Matières*': 'Histoire', 'Taux horaire FCFA': '' },
    ];

    const report = await service.dryRun('teachers', await toWorkbookBuffer(rows), db);
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: 'Salaire mensuel FCFA' })])
    );
  });
});

// ---------------------------------------------------------------------------
// Teachers - confirm
// ---------------------------------------------------------------------------

describe('import.service - teachers confirm', () => {
  it('collision username → upsertTeacher appelé 2 fois avec usernames distincts', async () => {
    repository.listTeacherDirectory.mockResolvedValue([]);
    const service = new ImportService(repository);

    const rows = [
      { 'Nom*': 'Diallo', 'Prénom*': 'Ibrahim', 'Type*': 'vacataire', 'Matières*': 'Mathématiques', 'Taux horaire FCFA': '5000' },
      { 'Nom*': 'Diallo', 'Prénom*': 'Ibrahim', 'Type*': 'vacataire', 'Matières*': 'Physique', 'Taux horaire FCFA': '4500' },
    ];

    await service.confirm('teachers', await toWorkbookBuffer(rows), db);

    expect(repository.upsertTeacher).toHaveBeenCalledTimes(2);
    expect(repository.upsertTeacher.mock.calls[0][1]).toMatchObject({ username: 'diallo.ibra' });
    expect(repository.upsertTeacher.mock.calls[1][1]).toMatchObject({ username: 'diallo.ibra2' });
  });

  it('mode replace → deactivateTeachersByIds appelé avec les IDs absents', async () => {
    repository.listExistingTeachers
      .mockResolvedValueOnce([]) // validateTeachers
      .mockResolvedValueOnce([  // confirmTeachers replace
        {
          id: 'teacher-old',
          userId: 'user-old',
          key: 'ancien prof',
          name: 'Ancien Prof',
          username: 'ancien.prof',
          matricule: null,
          type: 'vacataire',
          subjects: ['Histoire'],
          hourlyRate: 3000,
          monthlySalary: null,
          isActive: true,
        },
      ]);
    repository.listTeacherDirectory.mockResolvedValue([]);

    const service = new ImportService(repository);
    const rows = [
      { 'Nom*': 'Diallo', 'Prénom*': 'Ibrahim', 'Type*': 'vacataire', 'Matières*': 'Mathématiques', 'Taux horaire FCFA': '5000' },
    ];

    await service.confirm('teachers', await toWorkbookBuffer(rows), db, { mode: 'replace' });

    expect(repository.deactivateTeachersByIds).toHaveBeenCalledWith(
      expect.anything(),
      ['user-old']
    );
  });

  it('invalide → IMPORT_VALIDATION_FAILED, aucun write DB', async () => {
    repository.listTeacherDirectory.mockResolvedValueOnce([]);
    const service = new ImportService(repository);
    const rows = [
      { 'Nom*': 'Bah', 'Prénom*': '', 'Type*': 'vacataire', 'Matières*': 'Histoire', 'Taux horaire FCFA': '3000' },
    ];

    await expect(service.confirm('teachers', await toWorkbookBuffer(rows), db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_VALIDATION_FAILED',
      statusCode: 400,
    });

    expect(repository.upsertTeacher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Schedule - dry-run
// ---------------------------------------------------------------------------

describe('import.service - schedule dry-run', () => {
  it('activePeriodId=null → IMPORT_NO_ACTIVE_PERIOD', async () => {
    repository.findActiveSchedulePeriodId.mockResolvedValueOnce(null);
    const service = new ImportService(repository);

    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    await expect(service.dryRun('schedule', await toWorkbookBuffer(rows), db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_NO_ACTIVE_PERIOD',
      statusCode: 400,
    });
  });

  it('créneau dans le passé → avertissement et ligne ignorée', async () => {
    // System time = 2026-04-01 08:00 UTC; slot start = 07:30 → already past
    const service = new ImportService(repository);

    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    // The active period validFrom = today (2026-04-01, a Wednesday); Lundi 7h30 is already past
    // for this week (2026-03-30), and next Lundi = 2026-04-06 < period end (2026-04-30) → future.
    // The slot itself at 07:30 on 2026-04-06 is after now (2026-04-01 08:00), so no error.
    // To trigger "past" we need a period that ends before the next Monday occurrence.
    repository.findSchedulePeriodById.mockResolvedValueOnce({
      id: 'period-1',
      valid_from: '2026-03-30',
      valid_to: '2026-04-01', // ends today → next Monday (2026-04-06) is out of range
    });
    repository.findActiveSchedulePeriodId.mockResolvedValueOnce('period-1');

    const report = await service.dryRun('schedule', await toWorkbookBuffer(rows), db);
    expect(report.valid).toBe(0);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: 'Jour*',
          message: expect.stringContaining('passée'),
          severity: 'warning',
        }),
      ])
    );
  });

  it('créneau avec occurrences passées et futures → avertissement mais ligne valide', async () => {
    const service = new ImportService(repository);

    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    repository.findSchedulePeriodById.mockResolvedValueOnce({
      id: 'period-1',
      valid_from: '2026-03-30',
      valid_to: '2026-04-30',
    });
    repository.findActiveSchedulePeriodId.mockResolvedValueOnce('period-1');

    const report = await service.dryRun('schedule', await toWorkbookBuffer(rows), db);

    expect(report.valid).toBe(1);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: 'Jour*',
          message: expect.stringContaining('passée'),
          severity: 'warning',
        }),
      ])
    );
  });

  it('prof ambigu dans le schedule → erreur', async () => {
    repository.listTeacherDirectory.mockResolvedValueOnce([
      { teacher_id: 't1', user_id: 'u1', name: 'Ibrahim Diallo', username: 'diallo.ibra', subjects: [] },
      { teacher_id: 't2', user_id: 'u2', name: 'Ibrahim Diallo', username: 'diallo.ibra2', subjects: [] },
    ]);
    const service = new ImportService(repository);

    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    const report = await service.dryRun('schedule', await toWorkbookBuffer(rows), db);
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('ambigu') })])
    );
  });

  it('prof avec accent différent → ligne valide', async () => {
    repository.listTeacherDirectory.mockResolvedValueOnce([
      { teacher_id: 'teacher-accent', user_id: 'user-accent', name: 'Jean Traoré', username: 'traore.jean', subjects: ['Mathématiques'] },
    ]);
    const service = new ImportService(repository);

    const rows = [
      { 'Nom professeur*': 'Jean Traore', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    const report = await service.dryRun('schedule', await toWorkbookBuffer(rows), db, {
      schedulePeriod: { weekStart: '2026-04-27', weekEnd: '2026-05-03' },
    });

    expect(report.valid).toBe(1);
    expect(report.errors).toHaveLength(0);
  });

  it('créneau avec séparateur et format différents → match par heures', async () => {
    const service = new ImportService(repository);

    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '07:30–09:00', Salle: 'Salle A1' },
    ];

    const report = await service.dryRun('schedule', await toWorkbookBuffer(rows), db, {
      schedulePeriod: { weekStart: '2026-04-27', weekEnd: '2026-05-03' },
    });

    expect(report.valid).toBe(1);
    expect(report.errors).toHaveLength(0);
  });

  it('créneau absent mais parsable → dry-run valide pour création en confirm', async () => {
    repository.listTimeSlots.mockResolvedValueOnce([]);
    const service = new ImportService(repository);

    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '09h00 - 10h30', Salle: 'Salle A1' },
    ];

    const report = await service.dryRun('schedule', await toWorkbookBuffer(rows), db, {
      schedulePeriod: { weekStart: '2026-04-27', weekEnd: '2026-05-03' },
    });

    expect(report.valid).toBe(1);
    expect(report.errors).toHaveLength(0);
  });

  it('weekStart === weekEnd → IMPORT_INVALID_PERIOD_RANGE', async () => {
    const service = new ImportService(repository);
    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    await expect(
      service.dryRun('schedule', await toWorkbookBuffer(rows), db, {
        schedulePeriod: { weekStart: '2026-04-27', weekEnd: '2026-04-27' },
      })
    ).rejects.toMatchObject<Partial<ImportModuleError>>({
      code: 'IMPORT_INVALID_PERIOD_RANGE',
      statusCode: 400,
    });
  });
});

// ---------------------------------------------------------------------------
// Schedule - confirm
// ---------------------------------------------------------------------------

describe('import.service - schedule confirm', () => {
  it('3 lignes valides → imported=3, updated=0', async () => {
    const service = new ImportService(repository);
    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Physique', 'Jour*': 'Mardi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'SVT', 'Jour*': 'Mercredi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    const workbook = await toWorkbookBuffer(rows);
    const dryRun = await service.dryRun('schedule', workbook, db, {
      schedulePeriod: { weekStart: '2026-04-27', weekEnd: '2026-05-03' },
    });
    expect(dryRun.errors).toEqual([]);

    const report = await service.confirm('schedule', workbook, db, {
      schedulePeriod: { weekStart: '2026-04-27', weekEnd: '2026-05-03' },
    });

    expect(report.imported).toBe(3);
    expect(report.updated).toBe(0);
    expect(repository.upsertSchedule).toHaveBeenCalledTimes(3);
  });

  it('invalide (prof introuvable) → IMPORT_VALIDATION_FAILED', async () => {
    const service = new ImportService(repository);
    const rows = [
      { 'Nom professeur*': 'Prof Inconnu', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    await expect(service.confirm('schedule', await toWorkbookBuffer(rows), db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_VALIDATION_FAILED',
      statusCode: 400,
    });
  });

  it('conflits non acknowledges → IMPORT_CONFLICT_ACK_REQUIRED', async () => {
    repository.findOverlappingSchedulePeriods.mockResolvedValueOnce([
      { id: 'period-existing', name: 'EDT S15', valid_from: '2026-04-13', valid_to: '2026-04-19' },
    ]);
    const service = new ImportService(repository);
    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    await expect(
      service.confirm('schedule', await toWorkbookBuffer(rows), db, {
        schedulePeriod: { weekStart: '2026-04-13', weekEnd: '2026-04-19' },
        conflictAcknowledged: false,
      })
    ).rejects.toMatchObject<Partial<ImportModuleError>>({
      code: 'IMPORT_CONFLICT_ACK_REQUIRED',
      statusCode: 400,
    });
  });

  it('conflits avec conflictAcknowledged=true → import réussi', async () => {
    repository.findOverlappingSchedulePeriods.mockResolvedValueOnce([
      { id: 'period-existing', name: 'EDT S15', valid_from: '2026-04-13', valid_to: '2026-04-19' },
    ]);
    const service = new ImportService(repository);
    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    const report = await service.confirm('schedule', await toWorkbookBuffer(rows), db, {
      schedulePeriod: { weekStart: '2026-04-13', weekEnd: '2026-04-19' },
      conflictAcknowledged: true,
    });

    expect(report.imported).toBe(1);
  });

  it('mode replace → deactivateSchedulesByPeriodExcluding appelé', async () => {
    const service = new ImportService(repository);
    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    await service.confirm('schedule', await toWorkbookBuffer(rows), db, {
      schedulePeriod: { weekStart: '2026-04-27', weekEnd: '2026-05-03' },
      mode: 'replace',
    });

    expect(repository.deactivateSchedulesByPeriodExcluding).toHaveBeenCalledWith(
      expect.anything(),
      'period-1',
      expect.any(Array)
    );
  });

  it('créneau absent en base → créé automatiquement puis utilisé', async () => {
    repository.listTimeSlots.mockResolvedValue([]);
    const service = new ImportService(repository);
    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '09h00 - 10h30', Salle: 'Salle A1' },
    ];

    const report = await service.confirm('schedule', await toWorkbookBuffer(rows), db, {
      schedulePeriod: { weekStart: '2026-04-27', weekEnd: '2026-05-03' },
    });

    expect(report.imported).toBe(1);
    expect(repository.findOrCreateTimeSlot).toHaveBeenCalledWith(expect.anything(), {
      label: '09:00 – 10:30',
      startTime: '09:00:00',
      endTime: '10:30:00',
    });
    expect(repository.upsertSchedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeSlotId: 'slot-created' })
    );
  });

  it('créneaux passés en confirm → ignorés sans bloquer les créneaux valides', async () => {
    repository.findSchedulePeriodById.mockResolvedValue({
      id: 'period-1',
      valid_from: '2026-03-30',
      valid_to: '2026-04-02',
    });
    repository.findActiveSchedulePeriodId.mockResolvedValue('period-1');
    repository.listTimeSlots.mockResolvedValue([
      {
        id: 'slot-1',
        label: '7h30 - 9h00',
        start_time: '07:30:00',
        end_time: '09:00:00',
      },
      {
        id: 'slot-2',
        label: '09h00 - 10h30',
        start_time: '09:00:00',
        end_time: '10:30:00',
      },
    ]);
    const service = new ImportService(repository);
    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Physique', 'Jour*': 'Mercredi', 'Créneau*': '09h00 - 10h30', Salle: 'Salle A1' },
    ];

    const report = await service.confirm('schedule', await toWorkbookBuffer(rows), db);

    expect(report.imported).toBe(1);
    expect(report.updated).toBe(0);
    expect(repository.upsertSchedule).toHaveBeenCalledTimes(1);
    expect(repository.upsertSchedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subject: 'Physique' }),
      expect.objectContaining({ startDate: '2026-04-01' })
    );
  });

  it('activePeriodId=null en confirm sans période → IMPORT_NO_ACTIVE_PERIOD', async () => {
    repository.findActiveSchedulePeriodId.mockResolvedValue(null);
    const service = new ImportService(repository);

    const rows = [
      { 'Nom professeur*': 'Ibrahim Diallo', 'Classe*': '3ème A', 'Matière*': 'Mathématiques', 'Jour*': 'Lundi', 'Créneau*': '7h30 - 9h00', Salle: 'Salle A1' },
    ];

    await expect(service.confirm('schedule', await toWorkbookBuffer(rows), db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_NO_ACTIVE_PERIOD',
    });
  });
});

// ---------------------------------------------------------------------------
// parseDateToIso - edge cases
// ---------------------------------------------------------------------------

describe('import.service - parseDateToIso (via dry-run students)', () => {
  it('format JJ/MM/AAAA accepté', async () => {
    const service = new ImportService(repository);
    const rows = [
      { 'Prénom*': 'Awa', 'Nom*': 'Bah', 'Classe*': '3ème A', 'Date de naissance': '15/03/2010' },
    ];

    const report = await service.dryRun('students', await toWorkbookBuffer(rows), db);
    expect(report.errors).toHaveLength(0);
  });

  it('format DD-MM-AAAA accepté', async () => {
    const service = new ImportService(repository);
    const rows = [
      { 'Prénom*': 'Awa', 'Nom*': 'Bah', 'Classe*': '3ème A', 'Date de naissance': '15-03-2010' },
    ];

    const report = await service.dryRun('students', await toWorkbookBuffer(rows), db);
    expect(report.errors).toHaveLength(0);
  });

  it('date invalide → erreur Date de naissance', async () => {
    const service = new ImportService(repository);
    const rows = [
      { 'Prénom*': 'Awa', 'Nom*': 'Bah', 'Classe*': '3ème A', 'Date de naissance': 'not-a-date' },
    ];

    const report = await service.dryRun('students', await toWorkbookBuffer(rows), db);
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: 'Date de naissance' })])
    );
  });
});
