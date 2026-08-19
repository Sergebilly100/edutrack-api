import { randomUUID } from 'node:crypto';

import {
  resolveMappingByHeaders,
  translateMappedValue,
  type MappingFieldDefinition,
} from '../../shared/import-mapping/engine.js';
import { parseMappingWorkbook } from '../../shared/import-mapping/workbook.js';
import { FinanceRepository, type FinanceDb } from './finance.repository.js';
import { PaymentImportRepository } from './payment-import.repository.js';
import type { PaymentMethod } from './finance.types.js';

const PAYMENT_TARGETS = ['matricule', 'montant', 'date', 'reference', 'method'] as const;
type PaymentTarget = typeof PAYMENT_TARGETS[number];
const PAYMENT_METHODS = new Set<PaymentMethod>(['cash', 'mobile_money', 'bank_transfer']);

export class PaymentImportError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) {
    super(message);
    this.name = 'PaymentImportError';
  }
}

const stringValue = (value: string | number | undefined): string => String(value ?? '').trim();

const parseAmount = (value: string | number | undefined): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const compact = stringValue(value).replace(/[\s\u00a0]/g, '').replace(',', '.');
  const parsed = Number(compact);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parsePaymentDate = (value: string | number | undefined): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
    return date.toISOString().slice(0, 10);
  }
  const text = stringValue(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`))) return text;
  const french = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(text);
  if (french) {
    const candidate = `${french[3]}-${french[2]}-${french[1]}`;
    return Number.isNaN(Date.parse(`${candidate}T00:00:00Z`)) ? null : candidate;
  }
  return null;
};

const assertProfileFields = (fields: MappingFieldDefinition[]): MappingFieldDefinition[] => {
  const targets = fields.map((field) => field.targetField);
  if (new Set(targets).size !== targets.length) {
    throw new PaymentImportError('Chaque champ cible ne peut être mappé qu’une fois', 400, 'MAPPING_TARGET_DUPLICATED');
  }
  if (fields.some((field) => !PAYMENT_TARGETS.includes(field.targetField as PaymentTarget))) {
    throw new PaymentImportError('Le profil contient un champ cible inconnu', 400, 'MAPPING_TARGET_UNKNOWN');
  }
  const missing = PAYMENT_TARGETS.filter((target) => !targets.includes(target));
  if (missing.length > 0) {
    throw new PaymentImportError(`Champs obligatoires non mappés : ${missing.join(', ')}`, 400, 'MAPPING_REQUIRED_FIELDS_MISSING');
  }
  const method = fields.find((field) => field.targetField === 'method')!;
  if (method.translations.length === 0 || method.translations.some((item) => !PAYMENT_METHODS.has(item.targetValue as PaymentMethod))) {
    throw new PaymentImportError('Les valeurs du mode de paiement doivent toutes être traduites', 400, 'MAPPING_METHOD_TRANSLATIONS_INVALID');
  }
  return fields.map((field) => ({ ...field, isRequired: true }));
};

export class PaymentImportService {
  constructor(private readonly repository: PaymentImportRepository) {}

  getProfile() {
    return this.repository.getActiveProfile('payments');
  }

  saveProfile(input: { label?: string; actorUserId: string; fields: MappingFieldDefinition[] }) {
    return this.repository.saveActiveProfile({
      importType: 'payments',
      label: input.label,
      actorUserId: input.actorUserId,
      fields: assertProfileFields(input.fields),
    });
  }

  async analyze(fileBuffer: Buffer) {
    const workbook = await this.parse(fileBuffer);
    const profile = await this.getProfile();
    const resolution = resolveMappingByHeaders(workbook.headers, profile?.fields ?? []);
    const distinctValuesByColumn = Object.fromEntries(workbook.headers.map((header) => [
      header,
      [...new Set(workbook.rows.map((row) => stringValue(row.values[header])).filter(Boolean))].slice(0, 100),
    ]));
    return {
      sheetName: workbook.sheetName,
      headers: workbook.headers,
      rowCount: workbook.rows.length,
      sampleRows: workbook.rows.slice(0, 10),
      profile,
      matchedFields: resolution.matched,
      unmatchedHeaders: resolution.unmatchedHeaders,
      missingRequiredTargets: profile ? resolution.missingRequiredTargets : [...PAYMENT_TARGETS],
      distinctValuesByColumn,
    };
  }

  async preview(fileBuffer: Buffer) {
    const workbook = await this.parse(fileBuffer);
    const profile = await this.getProfile();
    if (!profile) throw new PaymentImportError('Configurez d’abord le profil de mapping', 409, 'MAPPING_PROFILE_REQUIRED');
    const resolution = resolveMappingByHeaders(workbook.headers, profile.fields);
    if (resolution.missingRequiredTargets.length > 0) {
      throw new PaymentImportError(
        `Colonnes obligatoires introuvables : ${resolution.missingRequiredTargets.join(', ')}`,
        422,
        'MAPPING_COLUMNS_MISSING'
      );
    }
    const activeYear = await this.repository.getActiveSchoolYear();
    if (!activeYear) throw new PaymentImportError('Aucune année scolaire active', 409, 'ACTIVE_SCHOOL_YEAR_REQUIRED');
    const fieldByTarget = new Map(resolution.matched.map((field) => [field.targetField, field] as const));
    const validRows: Array<{
      rowNumber: number; studentId: string; matricule: string; studentName: string; className: string;
      amount: number; paymentDate: string; reference: string; method: PaymentMethod;
    }> = [];
    const errors: Array<{ rowNumber: number; reason: string }> = [];

    for (const row of workbook.rows) {
      const valueFor = (target: PaymentTarget) => row.values[fieldByTarget.get(target)!.sourceColumnLabel];
      const matricule = stringValue(valueFor('matricule'));
      const amount = parseAmount(valueFor('montant'));
      const paymentDate = parsePaymentDate(valueFor('date'));
      const reference = stringValue(valueFor('reference'));
      const rawMethod = stringValue(valueFor('method'));
      const translated = translateMappedValue(fieldByTarget.get('method')!, rawMethod);
      const reasons: string[] = [];
      if (!matricule) reasons.push('matricule manquant');
      if (amount === null) reasons.push('montant invalide');
      if (!paymentDate) reasons.push('date de paiement invalide');
      if (!reference) reasons.push('référence de paiement manquante');
      if (!translated || !PAYMENT_METHODS.has(translated as PaymentMethod)) reasons.push(`mode de paiement non traduit : ${rawMethod || 'vide'}`);
      if (paymentDate && (paymentDate < activeYear.start_date || paymentDate > activeYear.end_date)) {
        reasons.push('date hors de l’année scolaire active');
      }
      const student = matricule ? await this.repository.findStudentByMatricule(matricule) : null;
      if (matricule && !student) reasons.push(`matricule introuvable : ${matricule}`);
      if (reasons.length > 0 || !student || amount === null || !paymentDate || !translated) {
        errors.push({ rowNumber: row.rowNumber, reason: reasons.join(' ; ') });
        continue;
      }
      validRows.push({
        rowNumber: row.rowNumber,
        studentId: student.id,
        matricule: student.matricule,
        studentName: student.student_name,
        className: student.class_name,
        amount,
        paymentDate,
        reference,
        method: translated as PaymentMethod,
      });
    }
    return { schoolYearId: activeYear.id, validRows, errors, totalRows: workbook.rows.length };
  }

  async confirm(fileBuffer: Buffer, actorUserId: string) {
    const preview = await this.preview(fileBuffer);
    await this.repository.db.transaction(async (tx) => {
      const finance = new FinanceRepository(tx as FinanceDb);
      for (const row of preview.validRows) {
        await finance.insertPayment({
          studentId: row.studentId,
          schoolYearId: preview.schoolYearId,
          amount: row.amount,
          method: row.method,
          source: 'bulk_import',
          confirmedByUserId: actorUserId,
          providerReference: row.reference,
          receiptNumber: `REC-${randomUUID()}`,
          paymentDate: row.paymentDate,
        });
      }
    });
    return { createdCount: preview.validRows.length, errors: preview.errors, totalRows: preview.totalRows };
  }

  private async parse(fileBuffer: Buffer) {
    try {
      return await parseMappingWorkbook(fileBuffer);
    } catch (error) {
      if (error instanceof PaymentImportError) throw error;
      const code = error instanceof Error ? error.message : 'IMPORT_FILE_INVALID';
      throw new PaymentImportError('Le fichier Excel est vide ou illisible', 400, code);
    }
  }
}

export const buildPaymentImportService = (db: FinanceDb): PaymentImportService =>
  new PaymentImportService(new PaymentImportRepository(db));
