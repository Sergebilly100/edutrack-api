import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import { MidyearImportService, parseRecoveryAmount, parseRecoveryDate, validateRecoveryRows } from '../../src/modules/finance/midyear-import.service.js';
import type { MidyearImportRepository, RecoverySnapshot } from '../../src/modules/finance/midyear-import.repository.js';
import type { MappingFieldDefinition } from '../../src/shared/import-mapping/engine.js';
import type { RecoveryRow } from '../../src/shared/import-mapping/midyear.types.js';

const snapshot = (): RecoverySnapshot => ({
  year: { id: 'year', startDate: '2026-09-01', endDate: '2027-06-30' },
  levels: [{ id: 'level', name: '6e' }], classes: [], students: [], enrollments: [], payments: [],
  plans: [{ levelId: 'level', totalAmount: '100000' }], rooms: [], subjects: [],
});

describe('C8 payment mapping safeguards', () => {
  const fields = (): MappingFieldDefinition[] => ['matricule', 'montant', 'date', 'reference', 'method'].map((targetField) => ({
    targetField, sourceColumnLabel: targetField, isRequired: true, translations: [],
  }));
  it.each(['date', 'reference', 'montant', 'matricule'])('rejects translations altering %s before saving', async (target) => {
    const mapping = fields();
    mapping.find((field) => field.targetField === target)!.translations = [{ sourceValue: 'original', targetValue: 'cash' }];
    const saveActiveProfile = vi.fn();
    const service = new MidyearImportService({ saveActiveProfile } as unknown as MidyearImportRepository);
    await expect(service.saveProfile({ importType: 'payments', actorUserId: 'actor', fields: mapping })).rejects.toMatchObject({ code: 'MAPPING_METHOD_TRANSLATIONS_INVALID' });
    expect(saveActiveProfile).not.toHaveBeenCalled();
  });
  it.each(['source-column', 'target-field', 'translation'])('rejects normalized duplicate %s mappings', async (duplicate) => {
    const mapping = fields();
    if (duplicate === 'source-column') mapping[1].sourceColumnLabel = ' MATRICULE ';
    if (duplicate === 'target-field') mapping[1].targetField = 'matricule';
    if (duplicate === 'translation') mapping[4].translations = [{ sourceValue: 'Orange Money', targetValue: 'mobile_money' }, { sourceValue: ' orange   money ', targetValue: 'cash' }];
    const service = new MidyearImportService({} as MidyearImportRepository);
    await expect(service.saveProfile({ importType: 'payments', actorUserId: 'actor', fields: mapping })).rejects.toMatchObject({
      code: duplicate === 'translation' ? 'MAPPING_TRANSLATION_AMBIGUOUS' : 'MAPPING_TARGET_DUPLICATED',
    });
  });
  it('revalidates legacy saved mappings before preview so references cannot be translated', async () => {
    const mapping = fields(); mapping[3].translations = [{ sourceValue: 'original', targetValue: 'cash' }];
    const getActiveProfile = vi.fn().mockResolvedValue({ fields: mapping });
    const snapshotMock = vi.fn();
    const service = new MidyearImportService({ getActiveProfile, snapshot: snapshotMock } as unknown as MidyearImportRepository);
    const book = new ExcelJS.Workbook(); book.addWorksheet('École').addRow(mapping.map((field) => field.sourceColumnLabel));
    await expect(service.preview('payments', Buffer.from(await book.xlsx.writeBuffer()), 'year')).rejects.toMatchObject({ code: 'MAPPING_METHOD_TRANSLATIONS_INVALID' });
    expect(snapshotMock).not.toHaveBeenCalled();
  });
});
const student = (values: Record<string, string> = {}, rowNumber = 2): RecoveryRow => ({ rowNumber,
  values: { matricule: 'M-1', nom: 'Koné', prenom: 'Aya', niveau: '6e', classe: '6e A', parent_phone: '', ...values } });
const payment = (values: Record<string, string> = {}, rowNumber = 2): RecoveryRow => ({ rowNumber,
  values: { matricule: 'M-1', montant: '15000,50', date: '12/10/2026', reference: ' ECOLE/001 ', method: 'mobile_money', ...values } });
const enrolled = () => {
  const data = snapshot();
  data.classes.push({ id: 'class', name: '6e A', levelId: 'level', isActive: true, hasAssignments: false });
  data.students.push({ id: 'student', matricule: 'M-1', firstName: 'Aya', lastName: 'Koné', isActive: true, lifecycleStatus: 'active' });
  data.enrollments.push({ id: 'enrollment', studentId: 'student', classId: 'class', status: 'confirmed' });
  return data;
};

describe('C8 recovery validation', () => {
  it('counts one future class for several valid enrollments and never writes during validation', () => {
    const data = snapshot();
    const result = validateRecoveryRows('students', [student(), student({ matricule: 'M-2', prenom: 'Ali' }, 3)], data);
    expect(result.impact).toMatchObject({ profilesCreated: 2, classesCreated: 1, enrollmentsCreated: 2 });
    expect(data.students).toEqual([]);
    expect(data.classes).toEqual([]);
  });
  it('reuses a C7 profile and creates its enrollment', () => {
    const data = enrolled(); data.enrollments = [];
    expect(validateRecoveryRows('students', [student()], data).impact).toMatchObject({ profilesReused: 1, classesReused: 1, enrollmentsCreated: 1 });
  });
  it('matches only case and surrounding spaces in a recovery matricule', () => {
    const data = enrolled(); data.enrollments = [];
    expect(validateRecoveryRows('students', [student({ matricule: ' m-1 ' })], data).impact.profilesReused).toBe(1);
    const collision = validateRecoveryRows('students', [student({ matricule: ' m-1 ', prenom: 'Ali' })], data);
    expect(collision.errors[0]).toMatchObject({ code: 'MATRICULE_ALREADY_EXISTS' });
    expect(validateRecoveryRows('students', [student({ matricule: 'M- 1' })], data).impact.profilesCreated).toBe(1);
  });
  it('reuses an already confirmed enrollment', () => {
    expect(validateRecoveryRows('students', [student()], enrolled()).impact.enrollmentsReused).toBe(1);
  });
  it.each(['identity', 'matricule', 'class', 'level', 'enrollment', 'inactive'])('rejects %s ambiguity without announcing writes', (kind) => {
    const data = enrolled();
    if (kind === 'identity') data.students[0].firstName = 'Autre';
    if (kind === 'matricule') data.students.push({ ...data.students[0], id: 'other' });
    if (kind === 'class') data.classes.push({ ...data.classes[0], id: 'other' });
    if (kind === 'level') data.levels.push({ id: 'other', name: '6E' });
    if (kind === 'enrollment') data.enrollments[0].classId = 'other';
    if (kind === 'inactive') data.students[0].isActive = false;
    const result = validateRecoveryRows('students', [student()], data);
    expect(result.validRows).toEqual([]); expect(result.errors).toHaveLength(1);
    expect(result.impact.enrollmentsCreated).toBe(0);
  });
  it('rejects all occurrences of a duplicate student and all conflicting class levels', () => {
    const duplicates = validateRecoveryRows('students', [student(), student({}, 3)], snapshot());
    expect(duplicates.errors.map((e) => e.rowNumber)).toEqual([2, 3]);
    const classes = validateRecoveryRows('students', [student(), student({ matricule: 'M-2', niveau: '5e' }, 3)], snapshot());
    expect(classes.validRows).toEqual([]);
  });
  it('preserves exact reference, method, amount and effective date', () => {
    const result = validateRecoveryRows('payments', [payment()], enrolled());
    expect(result.validRows[0]).toMatchObject({ studentId: 'student', enrollmentId: 'enrollment', values: { montant: '15000.50', date: '2026-10-12', reference: ' ECOLE/001 ', method: 'mobile_money' } });
  });
  it.each(['no-enrollment', 'pending', 'no-plan', 'unknown-method', 'outside-year', 'bad-date', 'precision'])('rejects payment %s without a replacement', (kind) => {
    const data = enrolled(); const row = payment();
    if (kind === 'no-enrollment') data.enrollments = [];
    if (kind === 'pending') data.enrollments[0].status = 'pending_cashier';
    if (kind === 'no-plan') data.plans = [];
    if (kind === 'unknown-method') row.values.method = 'Orange Money';
    if (kind === 'outside-year') row.values.date = '2025-10-12';
    if (kind === 'bad-date') row.values.date = '2026-02-30';
    if (kind === 'precision') row.values.montant = '100.009';
    const result = validateRecoveryRows('payments', [row], data);
    expect(result.validRows).toEqual([]); expect(result.errors[0].reason).toBeTruthy();
  });
  it('reuses a migration reference only if every financial field and student matches', () => {
    const data = enrolled();
    data.payments.push({ id: 'payment', studentId: 'student', reference: ' ECOLE/001 ', amount: '15000.50', date: '2026-10-12', method: 'mobile_money', status: 'confirmed', source: 'migration_import' });
    expect(validateRecoveryRows('payments', [payment()], data).impact.paymentsReused).toBe(1);
    expect(validateRecoveryRows('payments', [payment({ montant: '20000' })], data).errors).toHaveLength(1);
  });
  it('rejects both repeated payment references in the file', () => {
    expect(validateRecoveryRows('payments', [payment(), payment({}, 3)], enrolled()).errors).toHaveLength(2);
  });
  it('validates real calendar dates, leap years and Excel dates', () => {
    expect(parseRecoveryDate('2026-02-30')).toBeNull();
    expect(parseRecoveryDate('29/02/2024')).toBe('2024-02-29');
    expect(parseRecoveryDate('29/02/2026')).toBeNull();
    expect(parseRecoveryDate(46266)).toBe('2026-09-01');
    expect(parseRecoveryDate(46266.5)).toBeNull();
  });
  it('accepts school amount formats without rounding or exceeding numeric precision', () => {
    expect(parseRecoveryAmount('15 000,50')).toBe('15000.50');
    for (const value of ['0', '-2', 'NaN', '1e5', '1.234', '10000000000']) expect(parseRecoveryAmount(value)).toBeNull();
  });
});
