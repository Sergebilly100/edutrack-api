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

export type ReEnrollmentCandidateRow = {
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  student_matricule: string | null;
  current_class_name: string;
  current_school_year_id: string;
  current_school_year_label: string;
  final_decision: 'promoted' | 'repeat' | 'expelled' | null;
  next_level_id: string | null;
  next_level_name: string | null;
  enrollment_id: string | null;
  enrollment_status: EnrollmentStatus | null;
  enrollment_class_name: string | null;
};

export type StudentAcademicSummaryRow = {
  school_year_id: string;
  school_year_label: string;
  school_year_start_date: string;
  class_name: string;
  final_decision: 'promoted' | 'repeat' | 'expelled' | null;
};

export type StudentSummaryProfile = {
  id: string;
  first_name: string;
  last_name: string;
  matricule: string | null;
};

export class EnrollmentsRepository {
  constructor(private readonly db: Db) {}

  async listEnrollments(filters: { schoolYearId?: string; levelId?: string; classId?: string; status?: EnrollmentStatus; type?: EnrollmentType; page: number; limit: number }) {
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
        AND (${filters.levelId ?? null}::uuid IS NULL OR c.level_id = ${filters.levelId ?? null}::uuid)
        AND (${filters.classId ?? null}::uuid IS NULL OR e.class_id = ${filters.classId ?? null}::uuid)
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
          AND (${filters.levelId ?? null}::uuid IS NULL OR EXISTS (
            SELECT 1 FROM classes c WHERE c.id = e.class_id AND c.level_id = ${filters.levelId ?? null}::uuid
          ))
          AND (${filters.classId ?? null}::uuid IS NULL OR e.class_id = ${filters.classId ?? null}::uuid)
          AND (${filters.status ?? null}::text IS NULL OR e.status::text = ${filters.status ?? null})
          AND (${filters.type ?? null}::text IS NULL OR e.type::text = ${filters.type ?? null})
      `),
    ]);
    return { rows: rows<EnrollmentRow>(result), total: Number(rows<{ total: string | number }>(totalResult)[0]?.total ?? 0) };
  }

  async listReEnrollmentCandidates(input: {
    schoolYearId?: string;
    sourceSchoolYearId?: string;
    levelId?: string;
    classId?: string;
    search?: string;
    page: number;
    limit: number;
  }) {
    const offset = (input.page - 1) * input.limit;
    const search = input.search ? `%${input.search}%` : null;
    const candidatesQuery = sql`
      SELECT
        s.id::text AS student_id,
        s.first_name AS student_first_name,
        s.last_name AS student_last_name,
        s.matricule AS student_matricule,
        current_class.name AS current_class_name,
        source_year.id::text AS current_school_year_id,
        source_year.label AS current_school_year_label,
        decision.final_decision::text AS final_decision,
        decision.next_level_id::text AS next_level_id,
        next_level.name AS next_level_name,
        enrollment.id::text AS enrollment_id,
        enrollment.status::text AS enrollment_status,
        enrollment_class.name AS enrollment_class_name
      FROM students s
      INNER JOIN classes current_class ON current_class.id = s.class_id
      INNER JOIN school_years source_year ON source_year.id = current_class.school_year_id
      LEFT JOIN school_years target_year ON target_year.id = ${input.schoolYearId ?? null}::uuid
      LEFT JOIN class_decisions decision
        ON decision.student_id = s.id
       AND decision.school_year_id = source_year.id
      LEFT JOIN levels next_level ON next_level.id = decision.next_level_id
      LEFT JOIN enrollments enrollment
        ON enrollment.student_id = s.id
       AND enrollment.school_year_id = target_year.id
      LEFT JOIN classes enrollment_class ON enrollment_class.id = enrollment.class_id
      WHERE (${input.schoolYearId ?? null}::uuid IS NULL OR (
          target_year.status = 'active'
          AND source_year.status = 'closed'
          AND target_year.start_date > source_year.end_date
        ))
        AND (${input.sourceSchoolYearId ?? null}::uuid IS NULL OR source_year.id = ${input.sourceSchoolYearId ?? null}::uuid)
        AND (${input.levelId ?? null}::uuid IS NULL OR current_class.level_id = ${input.levelId ?? null}::uuid)
        AND (${input.classId ?? null}::uuid IS NULL OR current_class.id = ${input.classId ?? null}::uuid)
        AND (${search}::text IS NULL OR (
          s.first_name ILIKE ${search}
          OR s.last_name ILIKE ${search}
          OR s.matricule ILIKE ${search}
        ))
      ORDER BY s.last_name ASC, s.first_name ASC, s.created_at ASC
    `;
    const [result, totalResult] = await Promise.all([
      this.db.execute<ReEnrollmentCandidateRow>(sql`${candidatesQuery} LIMIT ${input.limit} OFFSET ${offset}`),
      this.db.execute<{ total: string | number }>(sql`SELECT COUNT(*) AS total FROM (${candidatesQuery}) candidates`),
    ]);
    return {
      rows: rows<ReEnrollmentCandidateRow>(result),
      total: Number(rows<{ total: string | number }>(totalResult)[0]?.total ?? 0),
    };
  }

  async getStudentSummaryProfile(studentId: string): Promise<StudentSummaryProfile | null> {
    const result = await this.db.execute<StudentSummaryProfile>(sql`
      SELECT id::text, first_name, last_name, matricule
      FROM students
      WHERE id = ${studentId}::uuid
      LIMIT 1
    `);
    return rows<StudentSummaryProfile>(result)[0] ?? null;
  }

  async listStudentAcademicSummary(studentId: string): Promise<StudentAcademicSummaryRow[]> {
    const result = await this.db.execute<StudentAcademicSummaryRow>(sql`
      WITH academic_history AS (
        SELECT
          school_year.id::text AS school_year_id,
          school_year.label AS school_year_label,
          school_year.start_date::text AS school_year_start_date,
          class.name AS class_name,
          decision.final_decision::text AS final_decision
        FROM enrollments enrollment
        INNER JOIN classes class ON class.id = enrollment.class_id
        INNER JOIN school_years school_year ON school_year.id = enrollment.school_year_id
        LEFT JOIN class_decisions decision
          ON decision.student_id = enrollment.student_id
         AND decision.school_year_id = school_year.id
        WHERE enrollment.student_id = ${studentId}::uuid

        UNION ALL

        SELECT
          school_year.id::text AS school_year_id,
          school_year.label AS school_year_label,
          school_year.start_date::text AS school_year_start_date,
          class.name AS class_name,
          decision.final_decision::text AS final_decision
        FROM students student
        INNER JOIN classes class ON class.id = student.class_id
        INNER JOIN school_years school_year ON school_year.id = class.school_year_id
        LEFT JOIN class_decisions decision
          ON decision.student_id = student.id
         AND decision.school_year_id = school_year.id
        WHERE student.id = ${studentId}::uuid
          AND NOT EXISTS (
            SELECT 1
            FROM enrollments enrollment
            WHERE enrollment.student_id = student.id
              AND enrollment.school_year_id = school_year.id
          )
      )
      SELECT school_year_id, school_year_label, school_year_start_date, class_name, final_decision
      FROM academic_history
      ORDER BY school_year_start_date DESC
    `);
    return rows<StudentAcademicSummaryRow>(result);
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

  async getReEnrollmentYearContext(studentId: string, targetSchoolYearId: string) {
    const result = await this.db.execute<{
      source_school_year_id: string;
      source_school_year_status: 'draft' | 'active' | 'closed';
      source_school_year_end_date: string;
      target_school_year_id: string | null;
      target_school_year_status: 'draft' | 'active' | 'closed' | null;
      target_school_year_start_date: string | null;
    }>(sql`
      SELECT
        source_year.id::text AS source_school_year_id,
        source_year.status::text AS source_school_year_status,
        source_year.end_date::text AS source_school_year_end_date,
        target_year.id::text AS target_school_year_id,
        target_year.status::text AS target_school_year_status,
        target_year.start_date::text AS target_school_year_start_date
      FROM students student
      INNER JOIN classes source_class ON source_class.id = student.class_id
      INNER JOIN school_years source_year ON source_year.id = source_class.school_year_id
      LEFT JOIN school_years target_year ON target_year.id = ${targetSchoolYearId}::uuid
      WHERE student.id = ${studentId}::uuid
      LIMIT 1
    `);
    return rows<{
      source_school_year_id: string;
      source_school_year_status: 'draft' | 'active' | 'closed';
      source_school_year_end_date: string;
      target_school_year_id: string | null;
      target_school_year_status: 'draft' | 'active' | 'closed' | null;
      target_school_year_start_date: string | null;
    }>(result)[0] ?? null;
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
