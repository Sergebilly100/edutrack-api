import type { AssignmentSnapshot } from '../../shared/import-mapping/teacher-assignments.js';
import { sql } from 'drizzle-orm';
import { confirmedSchoolClassCount } from '../../shared/database/confirmed-school-membership.js';
import { invalidateSchoolDerivedStudent } from '../../shared/database/invalidate-school-derived-student.js';
import type { TenantDb } from '../../shared/database/db.js';
import { MappingRepository } from '../../shared/import-mapping/mapping.repository.js';
import { normalizeMappingLabel } from '../../shared/import-mapping/engine.js';
import { trimMatricule } from '../../shared/utils/matricule.js';
import { MidyearImportError, type RecoveryImpact, type RecoveryRow } from '../../shared/import-mapping/midyear.types.js';
import { FinanceRepository } from './finance.repository.js';
import { FinancialCacheRepository } from './financial-cache.repository.js';
import { FinancialCacheService } from './financial-cache.service.js';
import type { PaymentMethod } from './finance.types.js';

export type RecoverySnapshot = {
  teachers?: AssignmentSnapshot['teachers'];
  assignments?: AssignmentSnapshot['assignments'];
  year: { id: string; startDate: string; endDate: string };
  levels: Array<{ id: string; name: string }>;
  classes: Array<{ id: string; name: string; levelId: string | null; isActive: boolean; hasAssignments: boolean; homeroomTeacherId?: string | null }>;
  students: Array<{ id: string; matricule: string | null; firstName: string; lastName: string; isActive: boolean; lifecycleStatus: string }>;
  enrollments: Array<{ id: string; studentId: string; classId: string; status: string }>;
  payments: Array<{ id: string; studentId: string; reference: string | null; amount: string; date: string; method: string; status: string; source: string }>;
  plans: Array<{ levelId: string; totalAmount: string }>;
  rooms: Array<{ id: string; name: string }>;
  subjects: Array<{ id: string; name: string; levelId: string }>;
};

export class MidyearImportRepository extends MappingRepository {
  async snapshot(yearId: string): Promise<RecoverySnapshot> {
    const years = await this.db.execute<{ id: string; startDate: string; endDate: string }>(sql`
      SELECT id::text, start_date::text AS "startDate", end_date::text AS "endDate"
      FROM school_years WHERE id = ${yearId}::uuid AND status = 'active'
    `);
    const year = years.rows[0];
    if (!year) throw new MidyearImportError('Sélectionnez une année scolaire active pour cette école', 409, 'ACTIVE_SCHOOL_YEAR_REQUIRED');
    // One connection per tenant. Keep queries sequential, including inside transactions.
    const levels = await this.db.execute<RecoverySnapshot['levels'][number]>(sql`SELECT id::text, name FROM levels ORDER BY id`);
    const classes = await this.db.execute<RecoverySnapshot['classes'][number]>(sql`
      SELECT c.id::text, c.name, c.level_id::text AS "levelId", c.is_active AS "isActive", c.homeroom_teacher_id::text AS "homeroomTeacherId",
        EXISTS(SELECT 1 FROM teacher_subject_assignments a WHERE a.class_id = c.id) AS "hasAssignments"
      FROM classes c WHERE c.school_year_id = ${yearId}::uuid ORDER BY c.id
    `);
    const students = await this.db.execute<RecoverySnapshot['students'][number]>(sql`
      SELECT id::text, matricule, first_name AS "firstName", last_name AS "lastName",
        is_active AS "isActive", lifecycle_status::text AS "lifecycleStatus" FROM students ORDER BY id
    `);
    const enrollments = await this.db.execute<RecoverySnapshot['enrollments'][number]>(sql`
      SELECT id::text, student_id::text AS "studentId", class_id::text AS "classId", status::text
      FROM enrollments WHERE school_year_id = ${yearId}::uuid ORDER BY id
    `);
    const payments = await this.db.execute<RecoverySnapshot['payments'][number]>(sql`
      SELECT id::text, student_id::text AS "studentId", provider_reference AS reference,
        amount::text, payment_date::text AS date, method::text, status::text, source::text
      FROM payments WHERE school_year_id = ${yearId}::uuid ORDER BY id
    `);
    const plans = await this.db.execute<RecoverySnapshot['plans'][number]>(sql`
      SELECT level_id::text AS "levelId", total_amount::text AS "totalAmount"
      FROM tuition_plans WHERE school_year_id = ${yearId}::uuid ORDER BY id
    `);
    const rooms = await this.db.execute<RecoverySnapshot['rooms'][number]>(sql`SELECT id::text, name FROM rooms ORDER BY id`);
    const subjects = await this.db.execute<RecoverySnapshot['subjects'][number]>(sql`SELECT id::text, name, level_id::text AS "levelId" FROM subjects ORDER BY id`);
    const teachers = await this.db.execute<AssignmentSnapshot['teachers'][number]>(sql`
      SELECT t.id::text, t.matricule, t.is_blocked AS "isBlocked", u.is_active AS "isActive"
      FROM teachers t JOIN users u ON u.id = t.user_id ORDER BY t.id
    `);
    const assignments = await this.db.execute<AssignmentSnapshot['assignments'][number]>(sql`
      SELECT a.teacher_id::text AS "teacherId", a.subject_id::text AS "subjectId", a.class_id::text AS "classId"
      FROM teacher_subject_assignments a JOIN classes c ON c.id = a.class_id
      WHERE c.school_year_id = ${yearId}::uuid ORDER BY a.teacher_id, a.subject_id, a.class_id
    `);
    return { teachers: teachers.rows, assignments: assignments.rows, year, levels: levels.rows, classes: classes.rows, students: students.rows, enrollments: enrollments.rows,
      payments: payments.rows, plans: plans.rows, rooms: rooms.rows, subjects: subjects.rows };
  }

  transaction<T>(yearId: string, run: (repository: MidyearImportRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const repository = new MidyearImportRepository(tx as TenantDb);
      // Serialize recovery retries, then revalidate the year and all dependencies under the lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${yearId}))`);
      await tx.execute(sql`SELECT id FROM school_years WHERE id = ${yearId}::uuid FOR UPDATE`);
      return run(repository);
    }, { isolationLevel: 'serializable' });
  }

  async recordAudit(importType: string, yearId: string, actorUserId: string, impact: RecoveryImpact): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO public.audit_financial_events (tenant_id, actor_id, actor_role, action, payload_after)
      SELECT id, ${actorUserId}::uuid, 'super_admin', ${`school.recovery.${importType}`},
        ${JSON.stringify({ schoolYearId: yearId, ...impact })}::jsonb
      FROM public.tenants WHERE schema_name = current_schema()
    `);
  }

  private async localActor(actorUserId: string): Promise<string | null> {
    const result = await this.db.execute<{ id: string }>(sql`SELECT id::text FROM users WHERE id = ${actorUserId}::uuid`);
    return result.rows[0]?.id ?? null;
  }

  async apply(importType: string, rows: RecoveryRow[], yearId: string, actorUserId: string): Promise<void> {
    const localActorId = await this.localActor(actorUserId);
    const createdClasses = new Map<string, string>();
    const touchedStudents = new Set<string>();
    const finance = new FinanceRepository(this.db);
    for (const row of rows) {
      const v = row.values;
      if (importType === 'teacher_assignments') {
        for (const pair of row.teachingAssignments ?? []) {
          await this.db.execute(sql`
            INSERT INTO teacher_subject_assignments (teacher_id, subject_id, class_id)
            VALUES (${pair.teacherId}::uuid, ${pair.subjectId}::uuid, ${pair.classId}::uuid)
          `);
        }
        continue;
      }
      if (importType === 'students') {
        let classId = row.classId;
        if (!classId) {
          const key = normalizeMappingLabel(v.classe);
          classId = createdClasses.get(key);
          if (!classId) {
            const result = await this.db.execute<{ id: string }>(sql`
              INSERT INTO classes (name, level_id, school_year_id, is_active)
              VALUES (${v.classe}, ${row.levelId}::uuid, ${yearId}::uuid, true) RETURNING id::text
            `);
            classId = result.rows[0]!.id;
            createdClasses.set(key, classId);
          }
        }
        let studentId = row.studentId;
        if (!studentId) {
          const result = await this.db.execute<{ id: string }>(sql`
            INSERT INTO students (matricule, first_name, last_name, parent_phone)
            VALUES (${trimMatricule(v.matricule)}, ${v.prenom}, ${v.nom}, ${v.parent_phone || null}) RETURNING id::text
          `);
          studentId = result.rows[0]!.id;
        }
        if (!row.enrollmentId) {
          await this.db.execute(sql`
            INSERT INTO enrollments (student_id, class_id, school_year_id, type, status, confirmed_by_user_id)
            VALUES (${studentId}::uuid, ${classId}::uuid, ${yearId}::uuid, 'new_registration', 'confirmed', ${localActorId}::uuid)
          `);
        }
        if (v.parent_phone) {
          const result = await this.db.execute<{ id: string }>(sql`
            INSERT INTO parents (full_name, phone, password_hash, is_active)
            VALUES (${`${v.nom} ${v.prenom}`}, ${v.parent_phone}, 'not-used', true)
            ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id::text
          `);
          await this.db.execute(sql`
            INSERT INTO parent_student_links (parent_id, student_id)
            VALUES (${result.rows[0]!.id}::uuid, ${studentId}::uuid) ON CONFLICT DO NOTHING
          `);
        }
        touchedStudents.add(studentId);
      } else if (importType === 'payments') {
        if (row.reused) continue;
        // Lock and recheck the enrollment immediately before inserting its financial entry.
        const enrollment = await finance.lockEnrollment(row.enrollmentId!);
        if (!enrollment || enrollment.status !== 'confirmed' || enrollment.student_id !== row.studentId || enrollment.school_year_id !== yearId) {
          throw new MidyearImportError('L’inscription a changé, prévisualisez de nouveau', 409, 'RECOVERY_PREVIEW_STALE');
        }
        await finance.insertPayment({
          studentId: row.studentId!, schoolYearId: yearId, amount: Number(v.montant), method: v.method as PaymentMethod,
          source: 'migration_import', confirmedByUserId: localActorId, providerReference: v.reference,
          paymentDate: v.date, receiptNumber: await finance.nextReceiptNumber(),
        });
        touchedStudents.add(row.studentId!);
      } else if (!row.reused) {
        switch (importType) {
          case 'levels': await this.db.execute(sql`INSERT INTO levels (name, order_index, is_exam_class) VALUES (${v.nom}, ${Number(v.ordre || 9999)}, false)`); break;
          case 'rooms': await this.db.execute(sql`INSERT INTO rooms (name, capacity, qr_token) VALUES (${v.nom}, ${v.capacite ? Number(v.capacite) : null}, gen_random_uuid()::text)`); break;
          case 'subjects': await this.db.execute(sql`INSERT INTO subjects (level_id, name, coefficient) VALUES (${row.levelId}::uuid, ${v.matiere}, ${Number(v.coefficient)})`); break;
          case 'classes': await this.db.execute(sql`INSERT INTO classes (name, level_id, school_year_id, is_active) VALUES (${v.nom}, ${row.levelId}::uuid, ${yearId}::uuid, true)`); break;
        }
      }
    }
    if (importType === 'teacher_assignments') {
      const teacherIds = [...new Set(rows.flatMap((row) => (row.teachingAssignments ?? []).map((pair) => pair.teacherId)))];
      for (const teacherId of teacherIds) await this.db.execute(sql`
        UPDATE teachers SET subjects = ARRAY(
          SELECT DISTINCT s.name FROM teacher_subject_assignments a
          JOIN subjects s ON s.id = a.subject_id JOIN classes c ON c.id = a.class_id
          JOIN school_years sy ON sy.id = c.school_year_id AND sy.status = 'active'
          WHERE a.teacher_id = ${teacherId}::uuid ORDER BY s.name
        ), updated_at = NOW(), updated_by = ${localActorId}::uuid WHERE id = ${teacherId}::uuid
      `);
      await this.db.execute(sql`
        INSERT INTO import_history (import_type, imported_count, updated_count, imported_by, imported_by_role)
        VALUES ('teachers', ${rows.reduce((count, row) => count + (row.teachingAssignments?.length ?? 0), 0)}, 0, ${localActorId}::uuid, 'super_admin')
      `);
    }
    if (importType === 'students' || importType === 'classes') {
      await this.db.execute(sql`
        UPDATE classes c SET student_count = ${confirmedSchoolClassCount(sql`c.id`, sql`c.school_year_id`)}
        WHERE c.school_year_id = ${yearId}::uuid
      `);
    }
    if (importType === 'students') {
      for (const studentId of touchedStudents) {
        await invalidateSchoolDerivedStudent(this.db, studentId, yearId);
      }
    }
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.db));
    if (touchedStudents.size) await cache.recalcAll(yearId);
    // Public admin_access_log records the real (possibly external) admin UUID.
    // Tenant audit retains only counts, type, UUID and role; never file contents.
    if (importType === 'students') {
      await this.db.execute(sql`
        INSERT INTO import_history (import_type, imported_count, updated_count, imported_by, imported_by_role)
        VALUES ('students', ${rows.filter((row) => !row.studentId).length}, ${rows.filter((row) => row.studentId).length}, ${localActorId}::uuid, 'super_admin')
      `);
    }
  }
}
