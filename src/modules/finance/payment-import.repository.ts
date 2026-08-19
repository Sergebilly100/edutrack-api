import { sql } from 'drizzle-orm';

import type { MappingFieldDefinition } from '../../shared/import-mapping/engine.js';
import type { FinanceDb } from './finance.repository.js';

const resultRows = <T>(result: unknown): T[] =>
  typeof result === 'object' && result !== null && 'rows' in result
    ? ((result as { rows: T[] }).rows ?? [])
    : [];

export type MappingProfile = {
  id: string;
  importType: string;
  label: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  fields: MappingFieldDefinition[];
};

export class PaymentImportRepository {
  constructor(readonly db: FinanceDb) {}

  async getActiveProfile(importType = 'payments'): Promise<MappingProfile | null> {
    const profileResult = await this.db.execute<{
      id: string; import_type: string; label: string | null; is_active: boolean;
      created_at: string; updated_at: string;
    }>(sql`
      SELECT id::text, import_type, label, is_active,
             created_at::text, updated_at::text
      FROM import_mapping_profiles
      WHERE import_type = ${importType} AND is_active = true
      LIMIT 1
    `);
    const profile = resultRows<{
      id: string; import_type: string; label: string | null; is_active: boolean;
      created_at: string; updated_at: string;
    }>(profileResult)[0];
    if (!profile) return null;

    const fieldsResult = await this.db.execute<{
      id: string; source_column_label: string; target_field: string; is_required: boolean;
    }>(sql`
      SELECT id::text, source_column_label, target_field, is_required
      FROM import_mapping_fields
      WHERE profile_id = ${profile.id}::uuid
      ORDER BY target_field
    `);
    const fieldRows = resultRows<{
      id: string; source_column_label: string; target_field: string; is_required: boolean;
    }>(fieldsResult);
    const fields: MappingFieldDefinition[] = [];
    for (const field of fieldRows) {
      const translationsResult = await this.db.execute<{ source_value: string; target_value: string }>(sql`
        SELECT source_value, target_value
        FROM import_mapping_value_translations
        WHERE mapping_field_id = ${field.id}::uuid
        ORDER BY source_value
      `);
      fields.push({
        id: field.id,
        sourceColumnLabel: field.source_column_label,
        targetField: field.target_field,
        isRequired: field.is_required,
        translations: resultRows<{ source_value: string; target_value: string }>(translationsResult).map((item) => ({
          sourceValue: item.source_value,
          targetValue: item.target_value,
        })),
      });
    }

    return {
      id: profile.id,
      importType: profile.import_type,
      label: profile.label,
      isActive: profile.is_active,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
      fields,
    };
  }

  async saveActiveProfile(input: {
    importType: string;
    label?: string;
    actorUserId: string;
    fields: MappingFieldDefinition[];
  }): Promise<MappingProfile> {
    return this.db.transaction(async (tx) => {
      const transactionDb = tx as FinanceDb;
      await transactionDb.execute(sql`
        UPDATE import_mapping_profiles
        SET is_active = false, updated_at = NOW()
        WHERE import_type = ${input.importType} AND is_active = true
      `);
      const profileResult = await transactionDb.execute<{ id: string }>(sql`
        INSERT INTO import_mapping_profiles (import_type, label, created_by_user_id, is_active)
        VALUES (${input.importType}, ${input.label ?? null}, ${input.actorUserId}::uuid, true)
        RETURNING id::text
      `);
      const profileId = resultRows<{ id: string }>(profileResult)[0]!.id;
      for (const field of input.fields) {
        const fieldResult = await transactionDb.execute<{ id: string }>(sql`
          INSERT INTO import_mapping_fields (
            profile_id, source_column_label, target_field, is_required
          ) VALUES (
            ${profileId}::uuid, ${field.sourceColumnLabel}, ${field.targetField}, ${field.isRequired}
          )
          RETURNING id::text
        `);
        const fieldId = resultRows<{ id: string }>(fieldResult)[0]!.id;
        for (const translation of field.translations) {
          await transactionDb.execute(sql`
            INSERT INTO import_mapping_value_translations (
              mapping_field_id, source_value, target_value
            ) VALUES (${fieldId}::uuid, ${translation.sourceValue}, ${translation.targetValue})
          `);
        }
      }
      return (await new PaymentImportRepository(transactionDb).getActiveProfile(input.importType))!;
    });
  }

  async getActiveSchoolYear(): Promise<{ id: string; start_date: string; end_date: string } | null> {
    const result = await this.db.execute<{ id: string; start_date: string; end_date: string }>(sql`
      SELECT id::text, start_date::text, end_date::text
      FROM school_years WHERE status = 'active' LIMIT 1
    `);
    return resultRows<{ id: string; start_date: string; end_date: string }>(result)[0] ?? null;
  }

  async findStudentByMatricule(matricule: string): Promise<{
    id: string; matricule: string; student_name: string; class_name: string;
  } | null> {
    const result = await this.db.execute<{
      id: string; matricule: string; student_name: string; class_name: string;
    }>(sql`
      SELECT s.id::text, s.matricule,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             c.name AS class_name
      FROM students s
      INNER JOIN classes c ON c.id = s.class_id
      WHERE lower(btrim(s.matricule)) = lower(btrim(${matricule}))
      LIMIT 1
    `);
    return resultRows<{
      id: string; matricule: string; student_name: string; class_name: string;
    }>(result)[0] ?? null;
  }
}
