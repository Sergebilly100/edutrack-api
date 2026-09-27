import { describe, expect, it, vi } from 'vitest';
import { createStudentBodySchema } from '../../src/modules/students/students.types.js';
import { createEnrollmentBodySchema } from '../../src/modules/enrollments/enrollments.types.js';
import { HistoricalStudentsService, validateHistoricalMapping, validateHistoricalRows, resolveInitialImportAccess, resolveHistoricalFields } from '../../src/modules/import-export/historical-students.service.js';
import type { HistoricalStudentsRepository } from '../../src/modules/import-export/historical-students.repository.js';
import { historicalSchoolYearSchema } from '../../src/modules/import-export/historical-students.types.js';
import { historicalStudentKey } from '../../src/modules/import-export/historical-students.identity.js';
import type { MappingFieldDefinition } from '../../src/shared/import-mapping/engine.js';

const fields: MappingFieldDefinition[] = ['matricule', 'nom', 'prenom', 'parent_phone'].map((targetField) => ({
  targetField, sourceColumnLabel: targetField, isRequired: targetField !== 'parent_phone', translations: [],
}));
const workbook = (values: Record<string, string | number>[]) => ({
  sheetName: 'Historique', headers: Object.keys(values[0]!), rows: values.map((row, index) => ({ rowNumber: index + 2, values: row })),
});

describe('historical student profile rules', () => {
  it('allows a profile without class while an enrollment requires class/year', () => {
    expect(createStudentBodySchema.parse({ first_name: 'Aya', last_name: 'Kone' }).class_id).toBeNull();
    expect(createEnrollmentBodySchema.safeParse({ studentId: 'e6473c31-16f3-4d08-96e6-a347df3278c2', type: 'new_registration' }).success).toBe(false);
  });
  it('maps historical identity without a class and keeps the phone optional', () => {
    const selected = fields.slice(0, 3).map((field) => ({ ...field, isRequired: false }));
    expect(validateHistoricalMapping(selected).filter((field) => field.isRequired).map((field) => field.targetField)).toEqual(['nom', 'prenom']);
    const result = validateHistoricalRows(workbook([{ matricule: 'H1', nom: 'Kone', prenom: 'Aya' }]), selected);
    expect(result.rows).toEqual([expect.objectContaining({ matricule: 'H1', nom: 'Kone', prenom: 'Aya', parent_phone: '', historical_class: '', rowNumber: 2 })]);
    expect(result.errors).toEqual([]);
  });
  it.each(['classe', 'school_year_id', 'montant', 'payment', 'document'])('rejects takeover target %s', (targetField) => {
    expect(() => validateHistoricalMapping([...fields, { ...fields[0]!, sourceColumnLabel: 'Other', targetField }])).toThrow('Champ non autorisé');
  });
  it('rejects reused normalized source columns and missing identity fields', () => {
    expect(() => validateHistoricalMapping([fields[0]!, { ...fields[1]!, sourceColumnLabel: ' MATRICULE ' }, fields[2]!])).toThrow('qu’une fois');
    expect(() => validateHistoricalMapping(fields.filter((field) => field.targetField !== 'nom'))).toThrow('Associez');
  });
  it('handles header order/case, value translations, and unmapped class columns', () => {
    const withTranslation = fields.map((field) => field.targetField === 'parent_phone'
      ? { ...field, translations: [{ sourceValue: 'local', targetValue: '2250700000000' }] } : field);
    const result = validateHistoricalRows(workbook([{ CLASSE: 'Ignore', PRENOM: 'Aya', NOM: 'Kone', MATRICULE: 'H1', PARENT_PHONE: 'LOCAL' }]), withTranslation);
    expect(result.rows[0]?.parent_phone).toBe('2250700000000');
    expect(result.preview[0]?.values).not.toHaveProperty('CLASSE');
  });
  it('reports invalid lines and fields, while keeping valid rows', () => {
    const result = validateHistoricalRows(workbook([
      { matricule: 'H1', nom: 'Kone', prenom: 'Aya', parent_phone: '2250700000000' },
      { matricule: 'H2', nom: '', prenom: 'Amadou', parent_phone: 'bad-phone' },
      { matricule: 'h1', nom: 'Kone', prenom: 'Aya', parent_phone: '' },
    ]), fields);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowNumber: 3, field: 'nom' }),
      expect.objectContaining({ rowNumber: 3, field: 'parent_phone' }),
      expect.objectContaining({ rowNumber: 4, field: 'matricule' }),
    ]));
    expect(JSON.stringify(result.errors)).not.toContain('bad-phone');
    expect(JSON.stringify(result.errors)).not.toContain('Amadou');
  });
  it('rejects missing columns even if a persisted profile marked them optional', () => {
    expect(() => validateHistoricalRows(workbook([{ matricule: 'H1', nom: 'Kone' }]), fields.map((field) => ({ ...field, isRequired: false })))).toThrow('prenom');
  });
  it('keeps legacy import out of initial configuration and reserves historical to director', async () => {
    const repository = { isInitialConfiguration: vi.fn().mockResolvedValue(true) } as unknown as HistoricalStudentsRepository;
    const service = new HistoricalStudentsService(repository);
    await expect(service.assertLegacyImportAllowed('director')).rejects.toMatchObject({ code: 'HISTORICAL_IMPORT_REQUIRED' });
    await expect(service.assertDirector('staff')).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.assertDirector('director')).resolves.toBeUndefined();
    vi.mocked(repository.isInitialConfiguration).mockResolvedValue(false);
    await expect(service.assertDirector('director')).rejects.toMatchObject({ code: 'INITIAL_IMPORT_CLOSED' });
    await expect(service.assertLegacyImportAllowed('director')).rejects.toMatchObject({ code: 'INITIAL_IMPORT_CLOSED' });
  });
});


describe('historical references and complete identity', () => {
  it('accepts a consecutive historical year without selecting the active year', () => {
    expect(historicalSchoolYearSchema.parse(' 2024 / 2025 ')).toBe('2024-2025');
    for (const year of ['', '2024', '2024-2026', '2025-2024', '1899-1900']) expect(historicalSchoolYearSchema.safeParse(year).success).toBe(false);
  });
  it('requires only name and first name and preserves both parents, DOB and old class', () => {
    const values = { nom: 'Kone', prenom: 'Aya', historical_class: '4e A', birth_date: '04/03/2010', parent_name: 'Parent A', parent_phone: '2250700000000', parent_email: 'parent@example.ci', parent_name_2: 'Parent B', parent_phone_2: '2250100000000' };
    const mapping = Object.keys(values).map((key) => ({ targetField: key, sourceColumnLabel: key, isRequired: false, translations: [] }));
    const result = validateHistoricalRows(workbook([values]), mapping);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ ...values, matricule: '', birth_date: '2010-03-04' });
    const invalid = validateHistoricalRows(workbook([{ ...values, birth_date: '31/02/2010', parent_email: 'bad', parent_phone_2: 'bad' }]), mapping);
    expect(invalid.errors.map((error) => error.field)).toEqual(expect.arrayContaining(['birth_date', 'parent_email', 'parent_phone_2']));
    expect(invalid.rows).toHaveLength(0);
  });
  it('uses the original class sheet only as a historical reference and deduplicates matricule-free lines', () => {
    const book = workbook([{ nom: 'Kone', prenom: 'Aya' }, { nom: 'KONE', prenom: 'AYA' }]);
    book.sheetName = '6e A';
    const result = validateHistoricalRows(book, fields.slice(1, 3));
    expect(result.rows[0]?.historical_class).toBe('6e A');
    expect(result.errors).toEqual([expect.objectContaining({ rowNumber: 3, field: 'profil' })]);
    const original = result.rows[0]!;
    expect(historicalStudentKey(original)).toBe(historicalStudentKey({ ...original, rowNumber: 99 }));
    expect(historicalStudentKey(original)).not.toBe(historicalStudentKey({ ...original, historical_class: '6e B' }));
  });
  it.each([[true, 'director', true], [false, 'director', false], [true, 'super_admin', false], [true, 'staff', false]])('scopes access to the initial director phase (%s, %s)', (initial, role, expected) => {
    expect(resolveInitialImportAccess(initial as boolean, role as string).canImportProfiles).toBe(expected);
  });
});


describe('historical mapping reuse', () => {
  it('keeps saved translations, completes parent aliases and omits storage identifiers', () => {
    const saved = [{ ...fields[1]!, id: 'storage-id', translations: [{ sourceValue: 'Source', targetValue: 'Target' }] }];
    const resolved = resolveHistoricalFields(['NOM', 'Prénom*', 'Nom parent 2'], saved);
    expect(resolved).toEqual(expect.arrayContaining([
      { ...fields[1]!, sourceColumnLabel: 'NOM', translations: saved[0]!.translations },
      { targetField: 'parent_name_2', sourceColumnLabel: 'Nom parent 2', isRequired: false, translations: [] },
    ]));
    expect(resolved.every((field) => !('id' in field))).toBe(true);
  });
  it('keeps a saved contact mapping when a required identity header has disappeared', () => {
    const resolved = resolveHistoricalFields(['Nom', 'Prénom'], [{ sourceColumnLabel: 'Nom', targetField: 'parent_name', isRequired: false, translations: [] }]);
    expect(resolved.map((field) => field.targetField)).toEqual(['parent_name', 'prenom']);
    expect(() => validateHistoricalMapping(resolved)).toThrow('Associez le nom');
  });
});
