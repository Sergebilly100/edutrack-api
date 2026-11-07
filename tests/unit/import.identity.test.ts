import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImportService } from '../../src/modules/import-export/import.service.js';

const repository = {
  listClasses: vi.fn(), listTeacherDirectory: vi.fn(), listExistingStudents: vi.fn(), listExistingTeachers: vi.fn(),
  deactivateStudentsByIds: vi.fn(), deactivateTeachersByIds: vi.fn(), upsertStudent: vi.fn(), upsertTeacher: vi.fn(),
  createImportHistory: vi.fn(), listImportHistory: vi.fn(),
};
const db = { execute: vi.fn(), transaction: vi.fn(<T>(fn: (tx: typeof db) => Promise<T>) => fn(db)) };

const toBuffer = async (rows: Record<string, string>[]): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  sheet.columns = headers.map((header) => ({ header, key: header }));
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const existingStudent = (overrides: Record<string, unknown> = {}) => ({
  id: 'existing', key: '3ème a::aya::kone', matricule: 'E-001', firstName: 'Aya', lastName: 'Kone', className: '3ème A',
  birthDate: null, sex: null, nationality: null, birthPlace: null, parentName: null, parentPhone: null,
  parentEmail: null, parentName2: null, parentPhone2: null, isActive: true, ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-04-01T08:00:00.000Z'));
  process.env.IMPORT_TEACHER_DEFAULT_PASSWORD = 'edutrack2024';
  repository.listClasses.mockResolvedValue([{ id: 'class-1', name: '3ème A' }]);
  repository.listTeacherDirectory.mockResolvedValue([]);
  repository.listExistingStudents.mockResolvedValue([]);
  repository.listExistingTeachers.mockResolvedValue([]);
  repository.deactivateStudentsByIds.mockResolvedValue(0);
  repository.deactivateTeachersByIds.mockResolvedValue(0);
  repository.upsertStudent.mockResolvedValue({ result: 'inserted' });
  repository.upsertTeacher.mockResolvedValue('inserted');
  repository.createImportHistory.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('import élèves : sexe, nationalité, lieu de naissance', () => {
  it('un ancien fichier sans nouvelles colonnes reste valide (champs non renseignés)', async () => {
    const service = new ImportService(repository);
    const file = await toBuffer([{ 'Prénom*': 'Awa', 'Nom*': 'Bah', 'Classe*': '3ème A' }]);
    expect((await service.dryRun('students', file, db)).errors).toHaveLength(0);
    await service.confirm('students', file, db);
    expect(repository.upsertStudent.mock.calls[0]![1]).toMatchObject({ sex: null, nationality: null, birthPlace: null });
  });

  it.each([
    ['M', 'M'], ['Féminin', 'F'], ['garcon', 'M'], ['FILLE', 'F'],
  ])('sexe « %s » → %s', async (raw, expected) => {
    const service = new ImportService(repository);
    await service.confirm('students', await toBuffer([{ 'Prénom*': 'Awa', 'Nom*': 'Bah', 'Classe*': '3ème A', Sexe: raw }]), db);
    expect(repository.upsertStudent.mock.calls[0]![1]).toMatchObject({ sex: expected });
  });

  it('colonnes reconnues malgré accents, casse et espaces ; nationalité par gentilé', async () => {
    const service = new ImportService(repository);
    await service.confirm('students', await toBuffer([{
      'Prénom*': 'Awa', 'Nom*': 'Bah', 'Classe*': '3ème A', ' NATIONALITE ': 'senegalaise', 'lieu  de naissance': '  Bouaké ', sexe: 'f',
    }]), db);
    expect(repository.upsertStudent.mock.calls[0]![1]).toMatchObject({ sex: 'F', nationality: 'SN', birthPlace: 'Bouaké' });
  });

  it('valeur invalide → erreur de ligne explicite, les autres lignes restent valides', async () => {
    const service = new ImportService(repository);
    const file = await toBuffer([
      { 'Prénom*': 'Awa', 'Nom*': 'Bah', 'Classe*': '3ème A', Nationalité: 'Ivoiriene' },
      { 'Prénom*': 'Yao', 'Nom*': 'Koffi', 'Classe*': '3ème A', Nationalité: 'Ivoirien', Sexe: 'X' },
      { 'Prénom*': 'Ali', 'Nom*': 'Traoré', 'Classe*': '3ème A', Nationalité: 'Malienne' },
    ]);
    const report = await service.dryRun('students', file, db);
    expect(report.valid).toBe(1);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 2, column: 'Nationalité', message: 'Nationalité non reconnue : « Ivoiriene »' }),
      expect.objectContaining({ row: 3, column: 'Sexe' }),
    ]));
  });

  it('cellule vide : ne propose aucun changement et transmet null (le repository ne remplace rien)', async () => {
    repository.listExistingStudents.mockResolvedValue([existingStudent({ sex: 'F', nationality: 'CI', birthPlace: 'Abidjan' })]);
    const service = new ImportService(repository);
    const file = await toBuffer([{ Matricule: 'E-001', 'Prénom*': 'Aya', 'Nom*': 'Kone', 'Classe*': '3ème A', Sexe: '', Nationalité: '', 'Lieu de naissance': '' }]);
    const report = await service.dryRun('students', file, db);
    expect(report.toUpdate).toHaveLength(0);
    await service.confirm('students', file, db);
    expect(repository.upsertStudent.mock.calls[0]![1]).toMatchObject({ sex: null, nationality: null, birthPlace: null });
  });

  it('valeur différente sur un profil existant → apparaît dans les changements', async () => {
    repository.listExistingStudents.mockResolvedValue([existingStudent({ nationality: 'CI' })]);
    const report = await new ImportService(repository).dryRun('students', await toBuffer([{
      Matricule: 'E-001', 'Prénom*': 'Aya', 'Nom*': 'Kone', 'Classe*': '3ème A', Nationalité: 'Burkinabè',
    }]), db);
    expect(report.toUpdate?.[0]?.changes).toMatchObject({ nationality: { before: 'CI', after: 'BF' } });
  });
});

describe('import professeurs : date de naissance, sexe, nationalité, lieu de naissance', () => {
  const base = { 'Nom*': 'Diallo', 'Prénom*': 'Ibrahim', 'Type*': 'vacataire', 'Taux horaire FCFA': '5000', Téléphone: '2250700000001' };

  it('ancien fichier valide ; nouveau fichier complet transmis au repository', async () => {
    const service = new ImportService(repository);
    expect((await service.dryRun('teachers', await toBuffer([base]), db)).errors).toHaveLength(0);
    await service.confirm('teachers', await toBuffer([{
      ...base, 'Date de naissance': '14/03/1985', Sexe: 'Masculin', Nationalité: 'Malien', 'Lieu de naissance': 'Bamako',
    }]), db);
    expect(repository.upsertTeacher.mock.calls[0]![1]).toMatchObject({
      birthDate: '1985-03-14', sex: 'M', nationality: 'ML', birthPlace: 'Bamako',
    });
  });

  it('valeurs invalides → erreurs de ligne explicites', async () => {
    const report = await new ImportService(repository).dryRun('teachers', await toBuffer([{
      ...base, Sexe: '?', Nationalité: 'Atlantide', 'Date de naissance': 'pas une date',
    }]), db);
    expect(report.valid).toBe(0);
    expect(report.errors.map((error) => error.column).sort()).toEqual(['Date de naissance', 'Nationalité', 'Sexe']);
  });
});
