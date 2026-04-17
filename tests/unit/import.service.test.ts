import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

import { ImportModuleError, ImportService } from '../../src/modules/import-export/import.service.js';

const repository = {
  listClasses: vi.fn(),
  listTeacherDirectory: vi.fn(),
  listRooms: vi.fn(),
  listTimeSlots: vi.fn(),
  findActiveSchedulePeriodId: vi.fn(),
  findOverlappingSchedulePeriods: vi.fn(),
  findOrCreateSchedulePeriod: vi.fn(),
  listExistingStudents: vi.fn(),
  deactivateStudentsByIds: vi.fn(),
  listExistingTeachers: vi.fn(),
  deactivateTeachersByIds: vi.fn(),
  upsertStudent: vi.fn(),
  upsertTeacher: vi.fn(),
  upsertSchedule: vi.fn(),
  createImportHistory: vi.fn(),
  listImportHistory: vi.fn(),
};

const db = {
  execute: vi.fn(),
};

const toWorkbookBuffer = (rows: Record<string, string>[]): Buffer => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

beforeEach(() => {
  vi.clearAllMocks();
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
    },
  ]);
  repository.listRooms.mockResolvedValue([{ id: 'room-1', name: 'Salle A1' }]);
  repository.listTimeSlots.mockResolvedValue([{ id: 'slot-1', label: '7h30 - 9h00' }]);
  repository.findActiveSchedulePeriodId.mockResolvedValue('period-1');
  repository.findOverlappingSchedulePeriods.mockResolvedValue([]);
  repository.findOrCreateSchedulePeriod.mockResolvedValue('period-1');
  repository.listExistingStudents.mockResolvedValue([]);
  repository.deactivateStudentsByIds.mockResolvedValue(0);
  repository.listExistingTeachers.mockResolvedValue([]);
  repository.deactivateTeachersByIds.mockResolvedValue(0);
  repository.upsertStudent.mockResolvedValue('inserted');
  repository.upsertTeacher.mockResolvedValue('inserted');
  repository.upsertSchedule.mockResolvedValue('inserted');
  repository.createImportHistory.mockResolvedValue(undefined);
  repository.listImportHistory.mockResolvedValue([]);
});

describe('import.service', () => {
  it('dry-run students valide retourne 20 valid, 0 errors et preview 5', async () => {
    const service = new ImportService(repository);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      'Prénom*': `Prenom${i + 1}`,
      'Nom*': `Nom${i + 1}`,
      'Classe*': '3ème A',
      'Téléphone parent': `2250700000${String(i + 1).padStart(3, '0')}`,
    }));

    const report = await service.dryRun('students', toWorkbookBuffer(rows), db);

    expect(report.valid).toBe(20);
    expect(report.errors).toHaveLength(0);
    expect(report.preview).toHaveLength(5);
  });

  it('dry-run students avec fichier sans colonnes requises -> IMPORT_MISSING_HEADERS', async () => {
    const service = new ImportService(repository);
    const rows = [{ Prenom: 'Awa', Nom: 'Kouassi', Classe: '3ème A' }];

    await expect(service.dryRun('students', toWorkbookBuffer(rows), db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_MISSING_HEADERS',
      statusCode: 400,
    });
  });

  it('dry-run students malformé retourne des erreurs précises avec numéros de lignes', async () => {
    const service = new ImportService(repository);
    const rows = [
      {
        'Prénom*': '',
        'Nom*': 'Nom1',
        'Classe*': '3ème A',
        'Téléphone parent': '2250700000001',
      },
      {
        'Prénom*': 'Awa',
        'Nom*': 'Nom2',
        'Classe*': 'Classe inconnue',
        'Téléphone parent': '2250700000002',
      },
      {
        'Prénom*': 'Yao',
        'Nom*': 'Nom3',
        'Classe*': '3ème A',
        'Téléphone parent': '0700000000',
      },
    ];

    const report = await service.dryRun('students', toWorkbookBuffer(rows), db);

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

  it('dry-run schedule avec activePeriodId=null -> IMPORT_NO_ACTIVE_PERIOD', async () => {
    repository.findActiveSchedulePeriodId.mockResolvedValueOnce(null);
    const service = new ImportService(repository);

    const rows = [
      {
        'Nom professeur*': 'Ibrahim Diallo',
        'Classe*': '3ème A',
        'Matière*': 'Mathématiques',
        'Jour*': 'Lundi',
        'Créneau*': '7h30 - 9h00',
        Salle: 'Salle A1',
      },
    ];

    await expect(service.dryRun('schedule', toWorkbookBuffer(rows), db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_NO_ACTIVE_PERIOD',
      statusCode: 400,
    });
  });

  it('dry-run teachers valide (5 lignes) -> valid=5, errors=[], preview=5', async () => {
    repository.listTeacherDirectory.mockResolvedValueOnce([]);
    const service = new ImportService(repository);

    const rows = Array.from({ length: 5 }, (_, i) => ({
      'Nom*': `Diallo${i + 1}`,
      'Prénom*': `Ibrahim${i + 1}`,
      'Type*': 'vacataire',
      'Matières*': 'Mathématiques, Physique',
      'Taux horaire FCFA': '5000',
    }));

    const report = await service.dryRun('teachers', toWorkbookBuffer(rows), db);

    expect(report.valid).toBe(5);
    expect(report.errors).toHaveLength(0);
    expect(report.preview).toHaveLength(5);
  });

  it('dry-run teachers collision username même fichier -> suffixe numérique sur le second', async () => {
    repository.listTeacherDirectory.mockResolvedValueOnce([]);
    const service = new ImportService(repository);

    const rows = [
      {
        'Nom*': 'Diallo',
        'Prénom*': 'Ibrahim',
        'Type*': 'vacataire',
        'Matières*': 'Mathématiques',
        'Taux horaire FCFA': '5000',
      },
      {
        'Nom*': 'Diallo',
        'Prénom*': 'Ibrahim',
        'Type*': 'vacataire',
        'Matières*': 'Physique',
        'Taux horaire FCFA': '4500',
      },
    ];

    const dryRun = await service.dryRun('teachers', toWorkbookBuffer(rows), db);
    expect(dryRun.valid).toBe(2);
    expect(dryRun.errors).toHaveLength(0);

    await service.confirm('teachers', toWorkbookBuffer(rows), db);

    expect(repository.upsertTeacher).toHaveBeenCalledTimes(2);
    expect(repository.upsertTeacher.mock.calls[0][1]).toMatchObject({ username: 'diallo.ibra' });
    expect(repository.upsertTeacher.mock.calls[1][1]).toMatchObject({ username: 'diallo.ibra2' });
  });

  it('confirm students valide importe les 20 lignes en DB', async () => {
    const service = new ImportService(repository);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      'Prénom*': `Prenom${i + 1}`,
      'Nom*': `Nom${i + 1}`,
      'Classe*': '3ème A',
      'Téléphone parent': '',
    }));

    const report = await service.confirm('students', toWorkbookBuffer(rows), db);

    expect(report.imported).toBe(20);
    expect(report.updated).toBe(0);
    expect(report.errors).toHaveLength(0);
    expect(repository.upsertStudent).toHaveBeenCalledTimes(20);
  });

  it('confirm schedule valide (3 lignes) -> imported=3, updated=0', async () => {
    const service = new ImportService(repository);
    const rows = [
      {
        'Nom professeur*': 'Ibrahim Diallo',
        'Classe*': '3ème A',
        'Matière*': 'Mathématiques',
        'Jour*': 'Lundi',
        'Créneau*': '7h30 - 9h00',
        Salle: 'Salle A1',
      },
      {
        'Nom professeur*': 'Ibrahim Diallo',
        'Classe*': '3ème A',
        'Matière*': 'Physique',
        'Jour*': 'Mardi',
        'Créneau*': '7h30 - 9h00',
        Salle: 'Salle A1',
      },
      {
        'Nom professeur*': 'Ibrahim Diallo',
        'Classe*': '3ème A',
        'Matière*': 'SVT',
        'Jour*': 'Mercredi',
        'Créneau*': '7h30 - 9h00',
        Salle: 'Salle A1',
      },
    ];

    const report = await service.confirm('schedule', toWorkbookBuffer(rows), db);

    expect(report.imported).toBe(3);
    expect(report.updated).toBe(0);
    expect(repository.upsertSchedule).toHaveBeenCalledTimes(3);
  });

  it('confirm schedule invalide (room manquante) -> IMPORT_VALIDATION_FAILED', async () => {
    const service = new ImportService(repository);
    const rows = [
      {
        'Nom professeur*': 'Ibrahim Diallo',
        'Classe*': '3ème A',
        'Matière*': 'Mathématiques',
        'Jour*': 'Lundi',
        'Créneau*': '7h30 - 9h00',
        Salle: 'Salle inconnue',
      },
    ];

    await expect(service.confirm('schedule', toWorkbookBuffer(rows), db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_VALIDATION_FAILED',
      statusCode: 400,
    });
  });

  it('confirm students invalide bloque sans écriture DB', async () => {
    const service = new ImportService(repository);
    const rows = [
      {
        'Prénom*': '',
        'Nom*': 'Nom1',
        'Classe*': '3ème A',
        'Téléphone parent': '2250700000001',
      },
    ];

    await expect(service.confirm('students', toWorkbookBuffer(rows), db)).rejects.toMatchObject<
      Partial<ImportModuleError>
    >({
      code: 'IMPORT_VALIDATION_FAILED',
      statusCode: 400,
    });

    expect(repository.upsertStudent).not.toHaveBeenCalled();
  });
});
