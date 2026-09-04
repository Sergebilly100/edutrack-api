import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { EnrollmentStatus, EnrollmentType, StudentDocumentStatus } from './enrollments.types.js';

type Db = NodePgDatabase<Record<string, unknown>>;
const rows = <T>(result: unknown): T[] =>
  typeof result === 'object' && result !== null && 'rows' in result
    ? ((result as { rows: T[] }).rows ?? [])
    : [];

export type EnrollmentRow = {
  id: string; student_id: string; class_id: string; school_year_id: string;
  type: EnrollmentType; status: EnrollmentStatus; enrolled_at: Date | string;
  confirmed_by_user_id: string | null; class_name: string; school_year_label: string;
  student_first_name: string; student_last_name: string;
  required_document_count: number; missing_mandatory_document_count: number;
};

export type StudentDocumentRow = {
  id: string; student_id: string; document_type_id: string; document_type_name: string;
  is_mandatory: boolean; is_active: boolean; status: StudentDocumentStatus; file_url: string | null;
  r2_key: string | null; provided_at: Date | string | null; notes: string | null;
};

export type RequiredDocumentTypeRow = {
  id: string; level_id: string; level_name?: string; name: string;
  is_mandatory: boolean; is_active: boolean; created_at: Date | string; updated_at: Date | string;
};

export class EnrollmentsRepository {
  constructor(private readonly db: Db) {}

  async listEnrollments(filters: { schoolYearId?: string; status?: EnrollmentStatus; type?: EnrollmentType; page: number; limit: number }) {
    const offset = (filters.page - 1) * filters.limit;
    const [result, totalResult] = await Promise.all([
      this.db.execute<EnrollmentRow>(sql`
      SELECT e.*, c.name AS class_name, sy.label AS school_year_label,
             s.first_name AS student_first_name, s.last_name AS student_last_name,
             COUNT(rdt.id)::int AS required_document_count,
             COUNT(rdt.id) FILTER (
               WHERE rdt.is_mandatory AND COALESCE(sd.status::text, 'missing') <> 'provided'
             )::int AS missing_mandatory_document_count
      FROM enrollments e
      INNER JOIN classes c ON c.id = e.class_id
      INNER JOIN school_years sy ON sy.id = e.school_year_id
      INNER JOIN students s ON s.id = e.student_id
      LEFT JOIN required_document_types rdt ON rdt.level_id = c.level_id AND rdt.is_active
      LEFT JOIN student_documents sd ON sd.student_id = e.student_id AND sd.document_type_id = rdt.id
      WHERE (${filters.schoolYearId ?? null}::uuid IS NULL OR e.school_year_id = ${filters.schoolYearId ?? null}::uuid)
        AND (${filters.status ?? null}::text IS NULL OR e.status::text = ${filters.status ?? null})
        AND (${filters.type ?? null}::text IS NULL OR e.type::text = ${filters.type ?? null})
      GROUP BY e.id, c.name, sy.label, s.first_name, s.last_name
      ORDER BY e.enrolled_at DESC
      LIMIT ${filters.limit}
      OFFSET ${offset}
    `),
      this.db.execute<{ total: string | number }>(sql`
        SELECT COUNT(*) AS total
        FROM enrollments e
        WHERE (${filters.schoolYearId ?? null}::uuid IS NULL OR e.school_year_id = ${filters.schoolYearId ?? null}::uuid)
          AND (${filters.status ?? null}::text IS NULL OR e.status::text = ${filters.status ?? null})
          AND (${filters.type ?? null}::text IS NULL OR e.type::text = ${filters.type ?? null})
      `),
    ]);
    return { rows: rows<EnrollmentRow>(result), total: Number(rows<{ total: string | number }>(totalResult)[0]?.total ?? 0) };
  }

  async findEnrollment(id: string) {
    const result = await this.db.execute<EnrollmentRow>(sql`
      SELECT e.*, c.name AS class_name, sy.label AS school_year_label,
             s.first_name AS student_first_name, s.last_name AS student_last_name,
             COUNT(rdt.id)::int AS required_document_count,
             COUNT(rdt.id) FILTER (
               WHERE rdt.is_mandatory AND COALESCE(sd.status::text, 'missing') <> 'provided'
             )::int AS missing_mandatory_document_count
      FROM enrollments e
      INNER JOIN classes c ON c.id = e.class_id
      INNER JOIN school_years sy ON sy.id = e.school_year_id
      INNER JOIN students s ON s.id = e.student_id
      LEFT JOIN required_document_types rdt ON rdt.level_id = c.level_id AND rdt.is_active
      LEFT JOIN student_documents sd ON sd.student_id = e.student_id AND sd.document_type_id = rdt.id
      WHERE e.id = ${id}::uuid
      GROUP BY e.id, c.name, sy.label, s.first_name, s.last_name
      LIMIT 1
    `);
    return rows<EnrollmentRow>(result)[0] ?? null;
  }

  async getStudentContext(studentId: string) {
    const result = await this.db.execute<{
      id: string; is_active: boolean; lifecycle_status: string; current_school_year_id: string | null;
      current_level_id: string | null; final_decision: 'promoted' | 'repeat' | 'expelled' | null; next_level_id: string | null;
    }>(sql`
      SELECT s.id, s.is_active, s.lifecycle_status, c.school_year_id AS current_school_year_id,
             c.level_id AS current_level_id,
             cd.final_decision, cd.next_level_id
      FROM students s
      INNER JOIN classes c ON c.id = s.class_id
      LEFT JOIN class_decisions cd ON cd.student_id = s.id AND cd.school_year_id = c.school_year_id
      WHERE s.id = ${studentId}::uuid LIMIT 1
    `);
    return rows<{ id: string; is_active: boolean; lifecycle_status: string; current_school_year_id: string | null; current_level_id: string | null; final_decision: 'promoted' | 'repeat' | 'expelled' | null; next_level_id: string | null }>(result)[0] ?? null;
  }

  async getStudentNotificationContext(studentId: string) {
    const result = await this.db.execute<{
      id: string;
      first_name: string;
      parent_phone: string | null;
      parent_phone_2: string | null;
    }>(sql`
      SELECT id, first_name, parent_phone, parent_phone_2
      FROM students
      WHERE id = ${studentId}::uuid
      LIMIT 1
    `);
    return rows<{
      id: string;
      first_name: string;
      parent_phone: string | null;
      parent_phone_2: string | null;
    }>(result)[0] ?? null;
  }

  async getClassContext(classId: string) {
    const result = await this.db.execute<{ id: string; level_id: string | null; school_year_id: string | null; is_active: boolean }>(sql`
      SELECT id, level_id, school_year_id, is_active FROM classes WHERE id = ${classId}::uuid LIMIT 1
    `);
    return rows<{ id: string; level_id: string | null; school_year_id: string | null; is_active: boolean }>(result)[0] ?? null;
  }

  async createEnrollment(input: { studentId: string; classId: string; schoolYearId: string; type: EnrollmentType; status: EnrollmentStatus }) {
    const result = await this.db.execute<{ id: string }>(sql`
      INSERT INTO enrollments (student_id, class_id, school_year_id, type, status)
      VALUES (${input.studentId}, ${input.classId}, ${input.schoolYearId}, ${input.type}::enrollment_type, ${input.status}::enrollment_status)
      RETURNING id
    `);
    return this.findEnrollment(rows<{ id: string }>(result)[0]!.id);
  }

  async updateEnrollment(id: string, input: { classId?: string; status?: EnrollmentStatus; confirmedByUserId?: string | null }) {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE enrollments SET
        class_id = CASE WHEN ${input.classId !== undefined} THEN ${input.classId ?? null}::uuid ELSE class_id END,
        status = CASE WHEN ${input.status !== undefined} THEN ${input.status ?? null}::enrollment_status ELSE status END,
        confirmed_by_user_id = CASE WHEN ${input.confirmedByUserId !== undefined} THEN ${input.confirmedByUserId ?? null}::uuid ELSE confirmed_by_user_id END,
        updated_at = NOW()
      WHERE id = ${id}::uuid RETURNING id
    `);
    return rows<{ id: string }>(result).length ? this.findEnrollment(id) : null;
  }

  async deleteEnrollment(id: string) {
    const result = await this.db.execute<{ id: string }>(sql`DELETE FROM enrollments WHERE id = ${id}::uuid RETURNING id`);
    return rows<{ id: string }>(result).length > 0;
  }

  async ensureRequiredDocuments(studentId: string, levelId: string) {
    const result = await this.db.execute<{ id: string }>(sql`
      INSERT INTO student_documents (student_id, document_type_id, status)
      SELECT ${studentId}::uuid, rdt.id, 'missing'::student_document_status
      FROM required_document_types rdt
      WHERE rdt.level_id = ${levelId}::uuid AND rdt.is_active
      ON CONFLICT (student_id, document_type_id) DO NOTHING RETURNING id
    `);
    return rows<{ id: string }>(result).length;
  }

  async listRequiredDocumentTypes(levelId?: string) {
    const result = await this.db.execute<RequiredDocumentTypeRow>(sql`
      SELECT rdt.*, l.name AS level_name FROM required_document_types rdt
      INNER JOIN levels l ON l.id = rdt.level_id
      WHERE rdt.is_active
        AND (${levelId ?? null}::uuid IS NULL OR rdt.level_id = ${levelId ?? null}::uuid)
      ORDER BY l.order_index, rdt.name
    `);
    return rows<RequiredDocumentTypeRow>(result);
  }

  async levelExists(levelId: string) {
    const result = await this.db.execute<{ exists: boolean }>(sql`SELECT EXISTS(SELECT 1 FROM levels WHERE id = ${levelId}::uuid) AS exists`);
    return rows<{ exists: boolean }>(result)[0]?.exists ?? false;
  }

  async levelsExist(levelIds: string[]) {
    const result = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM levels
      WHERE id IN (${sql.join(levelIds.map((levelId) => sql`${levelId}::uuid`), sql`, `)})
    `);
    return Number(rows<{ count: number }>(result)[0]?.count ?? 0) === levelIds.length;
  }

  async listRequiredDocumentLevels() {
    const result = await this.db.execute<{ id: string; name: string; order_index: number }>(sql`
      SELECT id, name, order_index
      FROM levels
      ORDER BY order_index, name
    `);
    return rows<{ id: string; name: string; order_index: number }>(result);
  }

  async createRequiredDocumentType(input: { levelId: string; name: string; isMandatory: boolean }) {
    const result = await this.db.execute<RequiredDocumentTypeRow>(sql`
      INSERT INTO required_document_types (level_id, name, is_mandatory, is_active)
      VALUES (${input.levelId}, ${input.name}, ${input.isMandatory}, true)
      ON CONFLICT (level_id, name) DO UPDATE SET
        is_mandatory = EXCLUDED.is_mandatory,
        is_active = true,
        updated_at = NOW()
      RETURNING *
    `);
    return rows<RequiredDocumentTypeRow>(result)[0];
  }

  async createRequiredDocumentTypes(inputs: Array<{ levelId: string; name: string; isMandatory: boolean }>) {
    return this.db.transaction(async (tx) => {
      const repository = new EnrollmentsRepository(tx as Db);
      const created: RequiredDocumentTypeRow[] = [];
      for (const input of inputs) {
        const documentType = await repository.createRequiredDocumentType(input);
        if (!documentType) throw new Error('Failed to create required document type');
        await repository.syncRequiredDocumentToOpenEnrollments(documentType.id, input.levelId);
        created.push(documentType);
      }
      return created;
    });
  }

  async requiredDocumentTypesExist(ids: string[]) {
    const result = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM required_document_types
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) AND is_active
    `);
    return Number(rows<{ count: number }>(result)[0]?.count ?? 0) === ids.length;
  }

  async findRequiredDocumentTypesByIds(ids: string[]) {
    const result = await this.db.execute<RequiredDocumentTypeRow>(sql`
      SELECT * FROM required_document_types
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) AND is_active
      ORDER BY created_at, id
    `);
    return rows<RequiredDocumentTypeRow>(result);
  }

  async syncRequiredDocumentTypes(input: {
    documentTypeIds: string[]; levelIds: string[]; name: string; isMandatory: boolean;
  }) {
    return this.db.transaction(async (tx) => {
      const repository = new EnrollmentsRepository(tx as Db);
      const existing = await repository.findRequiredDocumentTypesByIds(input.documentTypeIds);
      if (existing.length !== input.documentTypeIds.length) throw new Error('Required document type group changed');
      const selectedLevels = new Set(input.levelIds);
      const retainedLevels = new Set<string>();

      for (const documentType of existing) {
        if (!selectedLevels.has(documentType.level_id)) {
          await repository.deleteRequiredDocumentType(documentType.id);
          continue;
        }
        const updated = await repository.updateRequiredDocumentType(documentType.id, {
          name: input.name,
          isMandatory: input.isMandatory,
        });
        if (!updated) throw new Error('Failed to update required document type');
        await repository.syncRequiredDocumentToOpenEnrollments(updated.id, documentType.level_id);
        retainedLevels.add(documentType.level_id);
      }

      for (const levelId of input.levelIds) {
        if (retainedLevels.has(levelId)) continue;
        const created = await repository.createRequiredDocumentType({
          levelId,
          name: input.name,
          isMandatory: input.isMandatory,
        });
        if (!created) throw new Error('Failed to create required document type');
        await repository.syncRequiredDocumentToOpenEnrollments(created.id, levelId);
      }

      return (await repository.listRequiredDocumentTypes()).filter(
        (documentType) => documentType.name === input.name && selectedLevels.has(documentType.level_id)
      );
    });
  }

  async updateRequiredDocumentType(id: string, input: { name?: string; isMandatory?: boolean; isActive?: boolean }) {
    const result = await this.db.execute<RequiredDocumentTypeRow>(sql`
      UPDATE required_document_types SET
        name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
        is_mandatory = CASE WHEN ${input.isMandatory !== undefined} THEN ${input.isMandatory ?? false} ELSE is_mandatory END,
        is_active = CASE WHEN ${input.isActive !== undefined} THEN ${input.isActive ?? false} ELSE is_active END,
        updated_at = NOW()
      WHERE id = ${id}::uuid RETURNING *
    `);
    return rows<RequiredDocumentTypeRow>(result)[0] ?? null;
  }

  async deleteRequiredDocumentType(id: string) {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE required_document_types
      SET is_active = false, updated_at = NOW()
      WHERE id = ${id}::uuid AND is_active
      RETURNING id
    `);
    return rows<{ id: string }>(result).length > 0;
  }

  async syncRequiredDocumentToOpenEnrollments(documentTypeId: string, levelId: string) {
    await this.db.execute(sql`
      INSERT INTO student_documents (student_id, document_type_id, status)
      SELECT DISTINCT e.student_id, ${documentTypeId}::uuid, 'missing'::student_document_status
      FROM enrollments e
      INNER JOIN classes c ON c.id = e.class_id
      WHERE c.level_id = ${levelId}::uuid
        AND e.status IN ('pending_cashier', 'pending_dossier', 'blocked_unpaid')
      ON CONFLICT (student_id, document_type_id) DO NOTHING
    `);
  }

  async syncActiveRequiredDocumentsForStudent(studentId: string) {
    await this.db.execute(sql`
      INSERT INTO student_documents (student_id, document_type_id, status)
      SELECT ${studentId}::uuid, rdt.id, 'missing'::student_document_status
      FROM required_document_types rdt
      WHERE rdt.is_active
        AND rdt.level_id = (
          SELECT c.level_id
          FROM enrollments e
          INNER JOIN classes c ON c.id = e.class_id
          WHERE e.student_id = ${studentId}::uuid
            AND e.status IN ('pending_cashier', 'pending_dossier', 'blocked_unpaid')
          ORDER BY e.enrolled_at DESC
          LIMIT 1
        )
      ON CONFLICT (student_id, document_type_id) DO NOTHING
    `);
  }

  async isDocumentTypeAllowedForStudent(studentId: string, documentTypeId: string) {
    const result = await this.db.execute<{ allowed: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM required_document_types rdt
        WHERE rdt.id = ${documentTypeId}::uuid
          AND rdt.is_active
          AND rdt.level_id = (
            SELECT c.level_id
            FROM enrollments e
            INNER JOIN classes c ON c.id = e.class_id
            WHERE e.student_id = ${studentId}::uuid
            ORDER BY e.enrolled_at DESC
            LIMIT 1
          )
      ) AS allowed
    `);
    return rows<{ allowed: boolean }>(result)[0]?.allowed ?? false;
  }

  async listStudentDocuments(studentId: string) {
    const result = await this.db.execute<StudentDocumentRow>(sql`
      SELECT sd.*, rdt.name AS document_type_name, rdt.is_mandatory, rdt.is_active
      FROM student_documents sd INNER JOIN required_document_types rdt ON rdt.id = sd.document_type_id
      WHERE sd.student_id = ${studentId}::uuid
        AND (
          (
            rdt.is_active
            AND rdt.level_id = (
              SELECT c.level_id
              FROM enrollments e
              INNER JOIN classes c ON c.id = e.class_id
              WHERE e.student_id = ${studentId}::uuid
              ORDER BY e.enrolled_at DESC
              LIMIT 1
            )
          )
          OR sd.status = 'provided'
        )
      ORDER BY rdt.name
    `);
    return rows<StudentDocumentRow>(result);
  }

  async findStudentDocument(id: string) {
    const result = await this.db.execute<StudentDocumentRow>(sql`
      SELECT sd.*, rdt.name AS document_type_name, rdt.is_mandatory, rdt.is_active
      FROM student_documents sd INNER JOIN required_document_types rdt ON rdt.id = sd.document_type_id
      WHERE sd.id = ${id}::uuid LIMIT 1
    `);
    return rows<StudentDocumentRow>(result)[0] ?? null;
  }

  async upsertStudentDocument(input: { studentId: string; documentTypeId: string; status: StudentDocumentStatus; r2Key?: string | null; fileUrl?: string | null; notes?: string | null }) {
    const result = await this.db.execute<{ id: string }>(sql`
      INSERT INTO student_documents (student_id, document_type_id, status, r2_key, file_url, notes, provided_at)
      VALUES (${input.studentId}, ${input.documentTypeId}, ${input.status}::student_document_status, ${input.r2Key ?? null}, ${input.fileUrl ?? null}, ${input.notes ?? null}, CASE WHEN ${input.status} = 'provided' THEN NOW() ELSE NULL END)
      ON CONFLICT (student_id, document_type_id) DO UPDATE SET
        status = EXCLUDED.status, r2_key = EXCLUDED.r2_key, file_url = EXCLUDED.file_url,
        notes = EXCLUDED.notes, provided_at = EXCLUDED.provided_at, updated_at = NOW()
      RETURNING id
    `);
    return this.findStudentDocument(rows<{ id: string }>(result)[0]!.id);
  }

  async updateStudentDocument(id: string, input: { status?: StudentDocumentStatus; r2Key?: string | null; fileUrl?: string | null; notes?: string | null }) {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE student_documents SET
        status = CASE WHEN ${input.status !== undefined} THEN ${input.status ?? null}::student_document_status ELSE status END,
        r2_key = CASE WHEN ${input.r2Key !== undefined} THEN ${input.r2Key ?? null} ELSE r2_key END,
        file_url = CASE WHEN ${input.fileUrl !== undefined} THEN ${input.fileUrl ?? null} ELSE file_url END,
        notes = CASE WHEN ${input.notes !== undefined} THEN ${input.notes ?? null} ELSE notes END,
        provided_at = CASE WHEN ${input.status === 'provided'} THEN COALESCE(provided_at, NOW()) WHEN ${input.status !== undefined} THEN NULL ELSE provided_at END,
        updated_at = NOW()
      WHERE id = ${id}::uuid RETURNING id
    `);
    return rows<{ id: string }>(result).length ? this.findStudentDocument(id) : null;
  }

  async deleteStudentDocument(id: string) {
    const existing = await this.findStudentDocument(id);
    if (!existing) return null;
    await this.db.execute(sql`DELETE FROM student_documents WHERE id = ${id}::uuid`);
    return existing;
  }
}
