import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { TenantDb } from '../../src/shared/database/db.js';
import { loadDemoMigrations } from '../../src/shared/database/demo/demo-migrations.js';
import { DemoRepository } from '../../src/shared/database/demo/demo.repository.js';
import { ReportCardsRepository } from '../../src/modules/report-cards/report-cards.repository.js';
import { ReportCardsService } from '../../src/modules/report-cards/report-cards.service.js';
import { AcademicGradingRepository } from '../../src/modules/academic/academic-grading.repository.js';
import { AcademicGradingService } from '../../src/modules/academic/academic-grading.service.js';

describe('C30 tenant migration', () => {
  it('installs claims, immutable audits, revisions and the class correction guard', async () => {
    const schema = `school_demo_c30_${randomBytes(4).toString('hex')}`;
    const statements = await loadDemoMigrations(schema);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST, max: 1 });
    try {
      await expect(drizzle(pool).transaction(async (tx) => {
        const repo = new DemoRepository(tx as unknown as TenantDb);
        await repo.migrate(schema, statements);
        const tables = await tx.execute<{ table_name: string }>(sql`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = ${schema} AND table_name IN
            ('report_card_claims', 'report_card_versions', 'academic_change_audit')
          ORDER BY table_name
        `);
        expect(tables.rows.map((row) => row.table_name)).toEqual([
          'academic_change_audit', 'report_card_claims', 'report_card_versions',
        ]);
        const guards = await tx.execute<{ tgname: string }>(sql`
          SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${schema} AND NOT t.tgisinternal
            AND tgname IN ('academic_change_audit_immutable', 'report_card_versions_guard')
          ORDER BY tgname
        `);
        expect(guards.rows.map((row) => row.tgname)).toEqual([
          'academic_change_audit_immutable', 'report_card_versions_guard',
        ]);
        const index = await tx.execute<{ indexdef: string }>(sql`
          SELECT indexdef FROM pg_indexes WHERE schemaname = ${schema}
            AND indexname = 'report_card_claims_open_scope_unique'
        `);
        expect(index.rows[0]?.indexdef).toContain('(grading_period_id, class_id)');
        expect(index.rows[0]?.indexdef).toMatch(/phase.*before/);
        throw new Error('ROLLBACK_C30_MIGRATION_TEST');
      })).rejects.toThrow('ROLLBACK_C30_MIGRATION_TEST');
    } finally {
      await pool.end();
    }
  }, 120_000);

  it('archives every published card, withdraws it from parents, then republishes one active revision', async () => {
    const schema = `school_demo_c30_${randomBytes(4).toString('hex')}`;
    const statements = await loadDemoMigrations(schema);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST, max: 1 });
    try {
      await expect(drizzle(pool).transaction(async (tx) => {
        await new DemoRepository(tx as unknown as TenantDb).migrate(schema, statements);
        const director = (await tx.execute<{ id: string }>(sql`
          INSERT INTO users (role, name, password_hash) VALUES ('director', 'Direction', 'test') RETURNING id::text
        `)).rows[0]!.id;
        const delegatedStaff = (await tx.execute<{ id: string }>(sql`
          INSERT INTO users (role, name, password_hash) VALUES ('staff', 'Censeur délégué', 'test') RETURNING id::text
        `)).rows[0]!.id;
        const teacherUser = (await tx.execute<{ id: string }>(sql`
          INSERT INTO users (role, name, password_hash) VALUES ('teacher', 'Professeur', 'test') RETURNING id::text
        `)).rows[0]!.id;
        const teacher = (await tx.execute<{ id: string }>(sql`
          INSERT INTO teachers (user_id, username, type) VALUES (${teacherUser}::uuid, 'prof-c30', 'permanent') RETURNING id::text
        `)).rows[0]!.id;
        const year = (await tx.execute<{ id: string }>(sql`
          INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date)
          VALUES ('C30 test', '2026-09-01', '2027-07-01', '2027-06-01') RETURNING id::text
        `)).rows[0]!.id;
        const level = (await tx.execute<{ id: string }>(sql`
          INSERT INTO levels (name, order_index) VALUES ('6e C30', 1) RETURNING id::text
        `)).rows[0]!.id;
        const klass = (await tx.execute<{ id: string }>(sql`
          INSERT INTO classes (name, level_id, school_year_id)
          VALUES ('6e A', ${level}::uuid, ${year}::uuid) RETURNING id::text
        `)).rows[0]!.id;
        const subject = (await tx.execute<{ id: string }>(sql`
          INSERT INTO subjects (level_id, name, coefficient)
          VALUES (${level}::uuid, 'Mathématiques', 4) RETURNING id::text
        `)).rows[0]!.id;
        const period = (await tx.execute<{ id: string }>(sql`
          INSERT INTO grading_periods (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
          VALUES (${year}::uuid, 'trimester', 1, 'T1', '2026-09-01', '2026-11-01', '2026-12-01') RETURNING id::text
        `)).rows[0]!.id;
        await tx.execute(sql`INSERT INTO teacher_subject_assignments (teacher_id, subject_id, class_id)
          VALUES (${teacher}::uuid, ${subject}::uuid, ${klass}::uuid)`);
        await tx.execute(sql`INSERT INTO class_subject_completion (class_id, subject_id, grading_period_id, status, completed_at)
          VALUES (${klass}::uuid, ${subject}::uuid, ${period}::uuid, 'completed', now())`);
        await tx.execute(sql`INSERT INTO grading_period_class_closures (class_id, grading_period_id)
          VALUES (${klass}::uuid, ${period}::uuid)`);
        const students: string[] = [];
        for (const name of ['Awa', 'Yao']) {
          const student = (await tx.execute<{ id: string }>(sql`
            INSERT INTO students (first_name, last_name) VALUES (${name}, 'Test') RETURNING id::text
          `)).rows[0]!.id;
          students.push(student);
          await tx.execute(sql`INSERT INTO enrollments (student_id, class_id, school_year_id, type, status)
            VALUES (${student}::uuid, ${klass}::uuid, ${year}::uuid, 'new_registration', 'confirmed')`);
          const card = (await tx.execute<{ id: string }>(sql`
            INSERT INTO report_cards (student_id, class_id, grading_period_id, general_average, rank,
              class_average, class_min_average, class_max_average, class_headcount, status,
              published_at, published_by_user_id)
            VALUES (${student}::uuid, ${klass}::uuid, ${period}::uuid, 12, 1, 12, 12, 12, 2,
              'published', now(), ${director}::uuid) RETURNING id::text
          `)).rows[0]!.id;
          await tx.execute(sql`INSERT INTO report_card_lines (report_card_id, subject_id, line_type, subject_average, subject_coefficient)
            VALUES (${card}::uuid, ${subject}::uuid, 'subject', 12, 4)`);
        }
        const evaluation = (await tx.execute<{ id: string }>(sql`
          INSERT INTO evaluations (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label)
          VALUES (${subject}::uuid, ${klass}::uuid, ${period}::uuid, ${teacher}::uuid, 'scheduled', 1, 'Devoir C30')
          RETURNING id::text
        `)).rows[0]!.id;
        await tx.execute(sql`INSERT INTO evaluation_grades (evaluation_id, student_id, score, max_score, comment)
          VALUES (${evaluation}::uuid, ${students[0]}::uuid, 12, 20, 'Avant correction')`);

        const cards = new ReportCardsService(new ReportCardsRepository(tx as unknown as TenantDb));
        const outsideStudent = (await tx.execute<{ id: string }>(sql`
          INSERT INTO students (first_name, last_name) VALUES ('Autre', 'Classe') RETURNING id::text
        `)).rows[0]!.id;
        await expect(cards.createClaim({ classId: klass, studentId: outsideStudent, subjectId: subject,
          gradingPeriodId: period, userId: director, reason: 'La note publiée est incorrecte' }))
          .rejects.toMatchObject({ code: 'CLAIM_STUDENT_CLASS_MISMATCH' });
        const { id: claimId } = await cards.createClaim({
          classId: klass, studentId: students[0], subjectId: subject, gradingPeriodId: period, userId: director,
          reason: 'Une note publiée est incorrecte',
        });
        expect(await cards.listClaims({ classId: klass, studentId: students[0] })).toMatchObject([
          { id: claimId, student_id: students[0], student_name: 'Awa Test' },
        ]);
        await expect(cards.decideClaim({ claimId, decision: 'approved', userId: delegatedStaff,
          reason: 'Erreur confirmée après vérification', canPublish: true, canCorrectPublished: false }))
          .rejects.toMatchObject({ code: 'PUBLISHED_CORRECTION_FORBIDDEN' });
        await cards.decideClaim({ claimId, decision: 'approved', userId: delegatedStaff,
          reason: 'Erreur confirmée après vérification', canPublish: true, canCorrectPublished: true });
        const remaining = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM report_cards`);
        expect(remaining.rows[0]!.count).toBe(0);
        const archived = await cards.listVersions(klass, period);
        expect(archived).toHaveLength(2);
        expect(archived.every((row) => row.revision === 1 && row.invalidated_at && row.invalidation_reason)).toBe(true);
        expect((archived[0]!.snapshot as { lines: unknown[] }).lines).toHaveLength(1);
        expect(await cards.isStudentReportInRevision(students[0]!)).toBe(true);
        const completion = await tx.execute<{ status: string }>(sql`SELECT status::text FROM class_subject_completion
          WHERE class_id = ${klass}::uuid AND subject_id = ${subject}::uuid`);
        expect(completion.rows[0]!.status).toBe('in_progress');
        const closure = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM grading_period_class_closures`);
        expect(closure.rows[0]!.count).toBe(0);

        const grading = new AcademicGradingService(new AcademicGradingRepository(tx as unknown as TenantDb));
        await grading.upsertGrade(evaluation, { studentId: students[0]!, score: 14, maxScore: 20, comment: 'Corrigée' }, teacherUser);
        await grading.upsertGrade(evaluation, { studentId: students[1]!, score: 14, maxScore: 20 }, teacherUser);
        await grading.upsertGrade(evaluation, { studentId: students[1]!, score: null, maxScore: 20 }, teacherUser);
        await expect(grading.updateCompletion({ classId: klass, subjectId: subject, gradingPeriodId: period, status: 'completed' }, teacherUser))
          .rejects.toMatchObject({ code: 'GRADES_INCOMPLETE' });
        await grading.upsertGrade(evaluation, { studentId: students[1]!, score: 14, maxScore: 20 }, teacherUser);
        await grading.updateCompletion({ classId: klass, subjectId: subject, gradingPeriodId: period, status: 'completed' }, teacherUser);
        for (const student of students) {
          const replacement = (await tx.execute<{ id: string }>(sql`
            INSERT INTO report_cards (student_id, class_id, grading_period_id, general_average, rank,
              class_average, class_min_average, class_max_average, class_headcount, status)
            VALUES (${student}::uuid, ${klass}::uuid, ${period}::uuid, 14, 1, 14, 14, 14, 2,
              'generated') RETURNING id::text
          `)).rows[0]!.id;
          await tx.execute(sql`INSERT INTO report_card_lines (report_card_id, subject_id, line_type, subject_average, subject_coefficient)
            VALUES (${replacement}::uuid, ${subject}::uuid, 'subject', 14, 4)`);
        }
        await new ReportCardsRepository(tx as unknown as TenantDb).markRegenerated(klass, period, director);
        await tx.execute(sql.raw(`
          CREATE FUNCTION c30_reject_partial_publication() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS (SELECT 1 FROM report_cards
              WHERE class_id = NEW.class_id AND grading_period_id = NEW.grading_period_id
                AND status = 'published') THEN
              RAISE EXCEPTION 'C30_TEST_SECOND_CARD_FAILURE';
            END IF;
            RETURN NEW;
          END $$
        `));
        await tx.execute(sql.raw(`CREATE TRIGGER c30_reject_partial_publication
          BEFORE UPDATE OF status ON report_cards FOR EACH ROW
          EXECUTE FUNCTION c30_reject_partial_publication()`));
        await expect(cards.publishBulk(klass, period, director)).rejects.toThrow();
        const rolledBack = await tx.execute<{ generated: number; published: number }>(sql`
          SELECT count(*) FILTER (WHERE status = 'generated')::int AS generated,
            count(*) FILTER (WHERE status = 'published')::int AS published
          FROM report_cards WHERE class_id = ${klass}::uuid AND grading_period_id = ${period}::uuid
        `);
        expect(rolledBack.rows[0]).toMatchObject({ generated: 2, published: 0 });
        expect((await cards.listVersions(klass, period)).filter((row) => row.invalidated_at === null)).toHaveLength(0);
        await tx.execute(sql.raw('DROP TRIGGER c30_reject_partial_publication ON report_cards'));
        await tx.execute(sql.raw('DROP FUNCTION c30_reject_partial_publication()'));
        expect(await cards.publishBulk(klass, period, director)).toEqual({ publishedCount: 2 });
        const versions = await cards.listVersions(klass, period);
        expect(versions).toHaveLength(4);
        expect(versions.filter((row) => row.invalidated_at === null)).toHaveLength(2);
        expect(versions.filter((row) => row.revision === 2)).toHaveLength(2);
        expect(await cards.isStudentReportInRevision(students[0]!)).toBe(false);
        const audit = await cards.listAcademicAudit(klass, period);
        expect(audit.map((row) => row.operation)).toEqual(expect.arrayContaining([
          'claim_created', 'claim_approved', 'correction_opened', 'grade_updated',
          'grade_created', 'grade_deleted', 'averages_recalculated', 'averages_validated', 'claim_corrected',
          'cards_regenerated', 'cards_republished',
        ]));
        expect(audit.find((row) => row.operation === 'grade_updated')).toMatchObject({
          actor_user_id: teacherUser, student_id: students[0], claim_id: claimId,
          old_value: { score: 12, maxScore: 20, comment: 'Avant correction' },
          new_value: { score: 14, maxScore: 20, comment: 'Corrigée' },
        });
        expect(audit.find((row) => row.operation === 'grade_deleted')).toMatchObject({
          actor_user_id: teacherUser, student_id: students[1], claim_id: claimId,
          old_value: { score: 14, maxScore: 20, comment: null }, new_value: null,
        });
        await tx.execute(sql.raw('SAVEPOINT c30_audit_immutable'));
        await expect(tx.execute(sql`UPDATE academic_change_audit SET new_value = 'null'::jsonb
          WHERE id = ${audit[0]!.id}::uuid`)).rejects.toThrow();
        await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT c30_audit_immutable'));
        await tx.execute(sql.raw('RELEASE SAVEPOINT c30_audit_immutable'));
        await tx.execute(sql.raw('SAVEPOINT c30_version_immutable'));
        await expect(tx.execute(sql`UPDATE report_card_versions SET snapshot = '{}'::jsonb
          WHERE id = ${versions[0]!.id}::uuid`)).rejects.toThrow();
        await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT c30_version_immutable'));
        await tx.execute(sql.raw('RELEASE SAVEPOINT c30_version_immutable'));
        throw new Error('ROLLBACK_C30_LIFECYCLE_TEST');
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'ROLLBACK_C30_LIFECYCLE_TEST') throw error;
        if (error instanceof Error && 'cause' in error && error.cause) throw error.cause;
        throw error;
      })).rejects.toThrow('ROLLBACK_C30_LIFECYCLE_TEST');
    } finally {
      await pool.end();
    }
  }, 120_000);
});
