import { describe, expect, it, vi } from 'vitest';
import { createStudentBodySchema } from '../../src/modules/students/students.types.js';
import { createEnrollmentBodySchema } from '../../src/modules/enrollments/enrollments.types.js';
import { HistoricalStudentsService, validateHistoricalMapping, validateHistoricalRows } from '../../src/modules/import-export/historical-students.service.js';
import type { HistoricalStudentsRepository } from '../../src/modules/import-export/historical-students.repository.js';
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
    expect(validateHistoricalMapping(selected).every((field) => field.isRequired)).toBe(true);
    const result = validateHistoricalRows(workbook([{ matricule: 'H1', nom: 'Kone', prenom: 'Aya' }]), selected);
    expect(result.rows).toEqual([{ matricule: 'H1', nom: 'Kone', prenom: 'Aya', parent_phone: '', rowNumber: 2 }]);
    expect(result.errors).toEqual([]);
  });
  it.each(['classe', 'school_year_id', 'montant', 'payment', 'document'])('rejects takeover target %s', (targetField) => {
    expect(() => validateHistoricalMapping([...fields, { ...fields[0]!, sourceColumnLabel: 'Other', targetField }])).toThrow('Champ non autorisé');
  });
  it('rejects reused normalized source columns and missing identity fields', () => {
    expect(() => validateHistoricalMapping([fields[0]!, { ...fields[1]!, sourceColumnLabel: ' MATRICULE ' }, fields[2]!])).toThrow('qu’une fois');
    expect(() => validateHistoricalMapping(fields.slice(1))).toThrow('Associez');
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
  });
});
