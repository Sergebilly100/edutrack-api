import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  resolveMappingByHeaders,
  translateMappedValue,
  type MappingFieldDefinition,
} from '../../shared/import-mapping/engine.js';
import { parseMappingWorkbook } from '../../shared/import-mapping/workbook.js';
import type { TenantDb } from '../../shared/database/db.js';
import { FinanceRepository, type FinanceDb } from './finance.repository.js';

const s = (value: unknown): string => String(value ?? '').trim();

export class MidyearImportError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) {
    super(message);
    this.name = 'MidyearImportError';
  }
}

type TargetDef = { key: string; required: boolean };

/** Champs cibles par import_type + dépendance (prérequis dans l'ordre strict). */
export const MIDYEAR_IMPORTS: Record<
  string,
  { targets: TargetDef[]; dependsOn: string | null }
> = {
  levels: { targets: [{ key: 'nom', required: true }, { key: 'ordre', required: false }], dependsOn: null },
  subjects: {
    targets: [
      { key: 'niveau', required: true },
      { key: 'matiere', required: true },
      { key: 'coefficient', required: true },
    ],
    dependsOn: 'levels',
  },
  rooms: { targets: [{ key: 'nom', required: true }, { key: 'capacite', required: false }], dependsOn: null },
  classes: { targets: [{ key: 'nom', required: true }, { key: 'niveau', required: true }], dependsOn: 'levels' },
  students: {
    targets: [
      { key: 'matricule', required: true },
      { key: 'nom', required: true },
      { key: 'prenom', required: true },
      { key: 'classe', required: true },
      { key: 'parent_phone', required: false },
    ],
    dependsOn: 'classes',
  },
  payments: {
    targets: [
      { key: 'matricule', required: true },
      { key: 'montant', required: true },
    ],
    dependsOn: 'students',
  },
};

export class MidyearImportService {
  constructor(readonly db: TenantDb) {}

  private async assertDependencies(importType: string): Promise<void> {
    const dep = MIDYEAR_IMPORTS[importType]?.dependsOn;
    if (!dep) return;

    const hasRows = (result: { rows?: unknown[] } | null | undefined): boolean =>
      ((result?.rows ?? []) as unknown[]).length > 0;
    const runCount = async (): Promise<number> => 0;
    void runCount;
    if (dep === 'levels') {
      if (!hasRows((await this.db.execute(sql`SELECT 1 FROM levels LIMIT 1`)) as { rows?: unknown[] })) throw new MidyearImportError('Importez d\'abord les niveaux', 409, 'DEPENDENCY_MISSING');
      return;
    }
    if (dep === 'rooms') return;
    if (dep === 'classes') {
      if (!hasRows((await this.db.execute(sql`SELECT 1 FROM classes WHERE is_active = true LIMIT 1`)) as { rows?: unknown[] })) throw new MidyearImportError('Importez d\'abord les classes', 409, 'DEPENDENCY_MISSING');
      return;
    }
    if (dep === 'students') {
      if (!hasRows((await this.db.execute(sql`SELECT 1 FROM students WHERE is_active = true LIMIT 1`)) as { rows?: unknown[] })) throw new MidyearImportError('Importez d\'abord les élèves', 409, 'DEPENDENCY_MISSING');
      return;
    }
  }

  async analyze(importType: string, fileBuffer: Buffer) {
    const config = MIDYEAR_IMPORTS[importType];
    if (!config) throw new MidyearImportError('Type d\'import inconnu', 400, 'IMPORT_TYPE_UNKNOWN');
    await this.assertDependencies(importType);

    const workbook = await parseMappingWorkbook(fileBuffer);
    const profileResult = await this.db.execute<{ fields: unknown }>(sql`
      SELECT json_agg(json_build_object(
        'sourceColumnLabel', f.source_column_label,
        'targetField', f.target_field,
        'translations', COALESCE((
          SELECT json_agg(json_build_object('sourceValue', t.source_value, 'targetValue', t.target_value))
          FROM import_mapping_value_translations t WHERE t.mapping_field_id = f.id
        ), '[]'::json)
      ) ORDER BY f.target_field)::json AS fields
      FROM import_mapping_fields f
      WHERE f.profile_id = (
        SELECT id FROM import_mapping_profiles
        WHERE import_type = ${'midyear_' + importType} AND is_active = true LIMIT 1
      )
    `);
    const fieldsRaw = (profileResult.rows?.[0]?.fields ?? []) as Array<{
      sourceColumnLabel: string; targetField: string; translations: Array<{ sourceValue: string; targetValue: string }>;
    }>;
    const fields: MappingFieldDefinition[] = fieldsRaw.map((f) => ({ ...f, isRequired: true }));

    const resolution = resolveMappingByHeaders(workbook.headers, fields);
    return {
      headers: workbook.headers,
      rowCount: workbook.rows.length,
      matchedFields: resolution.matched,
      unmatchedHeaders: resolution.unmatchedHeaders,
      missingTargets: config.targets.filter((t) => t.required).map((t) => t.key),
      sampleRows: workbook.rows.slice(0, 10),
    };
  }

  async confirm(importType: string, fileBuffer: Buffer): Promise<{ createdCount: number; errors: Array<{ rowNumber: number; reason: string }>; totalRows: number }> {
    const config = MIDYEAR_IMPORTS[importType];
    if (!config) throw new MidyearImportError('Type d\'import inconnu', 400, 'IMPORT_TYPE_UNKNOWN');
    await this.assertDependencies(importType);

    const workbook = await parseMappingWorkbook(fileBuffer);
    const profileResult = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM import_mapping_profiles
      WHERE import_type = ${'midyear_' + importType} AND is_active = true LIMIT 1
    `);
    const profileId = profileResult.rows?.[0]?.id;
    if (!profileId) throw new MidyearImportError('Configurez d\'abord le mapping pour ce fichier', 409, 'MAPPING_PROFILE_REQUIRED');

    // Mapping résolu depuis le profil actif
    const fieldsRows = await this.db.execute<{ source_column_label: string; target_field: string }>(sql`
      SELECT source_column_label, target_field FROM import_mapping_fields WHERE profile_id = ${profileId}::uuid
    `);
    const fields: MappingFieldDefinition[] = (fieldsRows.rows ?? []).map((row) => ({
      sourceColumnLabel: row.source_column_label,
      targetField: row.target_field,
      isRequired: true,
      translations: [],
    }));
    const resolution = resolveMappingByHeaders(workbook.headers, fields);
    if (resolution.missingRequiredTargets.length > 0) {
      throw new MidyearImportError(`Colonnes introuvables : ${resolution.missingRequiredTargets.join(', ')}`, 422, 'MAPPING_COLUMNS_MISSING');
    }

    const valueFor = (row: Record<string, unknown>, target: string): string => {
      const field = resolution.matched.find((f) => f.targetField === target);
      if (!field) return '';
      let value = s((row.values as Record<string, unknown>)[field.sourceColumnLabel]);
      const rule = fields.find((f) => f.targetField === target);
      if (rule && rule.translations.length > 0) {
        const translated = translateMappedValue(rule, value);
        value = translated ?? value;
      }
      return value;
    };

    const activeYear = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM school_years WHERE status = 'active' LIMIT 1
    `);
    const yearId = activeYear.rows?.[0]?.id;
    if (!yearId) throw new MidyearImportError('Aucune année scolaire active', 409, 'ACTIVE_SCHOOL_YEAR_REQUIRED');

    const errors: Array<{ rowNumber: number; reason: string }> = [];
    let createdCount = 0;

    for (const row of workbook.rows) {
      try {
        switch (importType) {
          case 'levels': {
            const name = valueFor(row, 'nom');
            if (!name) { errors.push({ rowNumber: row.rowNumber, reason: 'nom manquant' }); continue; }
            const order = Number(valueFor(row, 'ordre')) || 9999;
            await this.db.execute(sql`
              INSERT INTO levels (name, order_index, is_exam_class)
              VALUES (${name}, ${order}, false)
              ON CONFLICT DO NOTHING
            `);
            createdCount += 1;
            break;
          }
          case 'subjects': {
            const levelName = valueFor(row, 'niveau');
            const name = valueFor(row, 'matiere');
            const coefficient = Number(valueFor(row, 'coefficient').replace(',', '.')) || 1;
            await this.db.execute(sql`
              INSERT INTO subjects (level_id, name, coefficient)
              SELECT l.id, ${name}, ${coefficient} FROM levels l WHERE lower(l.name) = lower(${levelName})
              ON CONFLICT DO NOTHING
            `);
            createdCount += 1;
            break;
          }
          case 'rooms': {
            const name = valueFor(row, 'nom');
            if (!name) { errors.push({ rowNumber: row.rowNumber, reason: 'nom manquant' }); continue; }
            const capacity = Number(valueFor(row, 'capacite')) || null;
            await this.db.execute(sql`
              INSERT INTO rooms (name, capacity, qr_token)
              VALUES (${name}, ${capacity}, ${randomUUID()})
              ON CONFLICT DO NOTHING
            `);
            createdCount += 1;
            break;
          }
          case 'classes': {
            const name = valueFor(row, 'nom');
            const levelName = valueFor(row, 'niveau');
            if (!name || !levelName) { errors.push({ rowNumber: row.rowNumber, reason: 'nom ou niveau manquant' }); continue; }
            const inserted = await this.db.execute<{ id: string }>(sql`
              INSERT INTO classes (name, level_id, school_year_id, is_active)
              SELECT ${name}, l.id, ${yearId}::uuid, true FROM levels l WHERE lower(l.name) = lower(${levelName})
              RETURNING id::text
            `);
            if ((inserted.rows ?? []).length === 0) {
              errors.push({ rowNumber: row.rowNumber, reason: `niveau inconnu : ${levelName}` });
            } else {
              createdCount += 1;
            }
            break;
          }
          case 'students': {
            const matricule = valueFor(row, 'matricule');
            const lastName = valueFor(row, 'nom');
            const firstName = valueFor(row, 'prenom');
            const className = valueFor(row, 'classe');
            const parentPhone = valueFor(row, 'parent_phone');
            if (!matricule || !lastName || !firstName) {
              errors.push({ rowNumber: row.rowNumber, reason: 'matricule, nom ou prénom manquant' });
              continue;
            }
            const inserted = await this.db.execute<{ id: string }>(sql`
              INSERT INTO students (class_id, first_name, last_name, matricule)
              SELECT c.id, ${firstName}, ${lastName}, ${matricule}
              FROM classes c WHERE lower(c.name) = lower(${className}) AND c.school_year_id = ${yearId}::uuid
              ON CONFLICT DO NOTHING
              RETURNING id::text
            `);
            const studentRow = inserted.rows?.[0];
            if (!studentRow) {
              errors.push({ rowNumber: row.rowNumber, reason: `classe inconnue : ${className}` });
              continue;
            }
            if (parentPhone) {
              const parent = await this.db.execute<{ id: string }>(sql`
                INSERT INTO parents (full_name, phone, password_hash, is_active)
                VALUES (${`${lastName} ${firstName}`}, ${parentPhone}, 'not-used', true)
                ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()
                RETURNING id::text
              `);
              const parentId = parent.rows?.[0]?.id;
              if (parentId) {
                await this.db.execute(sql`
                  INSERT INTO parent_student_links (parent_id, student_id)
                  VALUES (${parentId}::uuid, ${studentRow.id}::uuid)
                  ON CONFLICT DO NOTHING
                `);
              }
            }
            createdCount += 1;
            break;
          }
          case 'payments': {
            const matricule = valueFor(row, 'matricule');
            const amount = Number(valueFor(row, 'montant').replace(',', '.'));
            if (!matricule || !Number.isFinite(amount) || amount <= 0) {
              errors.push({ rowNumber: row.rowNumber, reason: 'matricule ou montant invalide' });
              continue;
            }
            const student = await this.db.execute<{ id: string }>(sql`
              SELECT id::text FROM students WHERE lower(btrim(matricule)) = lower(${matricule}) LIMIT 1
            `);
            const studentRow = student.rows?.[0];
            if (!studentRow) {
              errors.push({ rowNumber: row.rowNumber, reason: `matricule introuvable : ${matricule}` });
              continue;
            }
            const finance = new FinanceRepository(this.db as FinanceDb);
            await finance.insertPayment({
              studentId: studentRow.id,
              schoolYearId: yearId,
              amount,
              method: 'cash',
              source: 'migration_import',
              confirmedByUserId: null,
              receiptNumber: `MIG-${randomUUID()}`,
              paymentDate: new Date().toISOString().slice(0, 10),
            });
            createdCount += 1;
            break;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'erreur inconnue';
        errors.push({ rowNumber: row.rowNumber, reason: message.slice(0, 200) });
      }
    }

    return { createdCount, errors, totalRows: workbook.rows.length };
  }
}

export const buildMidyearImportService = (db: ConstructorParameters<typeof MidyearImportService>[0]) =>
  new MidyearImportService(db);
