import { sql } from 'drizzle-orm';
import { confirmedSchoolStudent } from '../../shared/database/confirmed-school-membership.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';
import type { EvaluationReviewOptions, EvaluationReviewOptionsQuery, EvaluationReviewQuery } from './evaluation-review.types.js';

type Db = NodePgDatabase<Record<string, unknown>>;
const rows = <T extends QueryResultRow>(result: QueryResult<T>): T[] => result.rows;

const scopeFilter = (query: EvaluationReviewQuery) => {
  const level = query.levelId ?? null;
  const selectedClass = query.classId ?? null;
  const subject = query.subjectId ?? null;
  const teacher = query.teacherId ?? null;
  return sql`e.grading_period_id = ${query.gradingPeriodId}::uuid AND c.school_year_id = ${query.schoolYearId}::uuid
    AND s.level_id = c.level_id
    AND (${level}::uuid IS NULL OR c.level_id = ${level}::uuid)
    AND (${selectedClass}::uuid IS NULL OR c.id = ${selectedClass}::uuid)
    AND (${subject}::uuid IS NULL OR e.subject_id = ${subject}::uuid)
    AND (${teacher}::uuid IS NULL OR e.teacher_id = ${teacher}::uuid)`;
};

export class EvaluationReviewRepository {
  constructor(private readonly db: Db) {}

  async options(query: EvaluationReviewOptionsQuery): Promise<EvaluationReviewOptions> {
    const year = query.schoolYearId ?? null;
    const period = query.gradingPeriodId ?? null;
    const level = query.levelId ?? null;
    const classId = query.classId ?? null;
    const subject = query.subjectId ?? null;
    const [years, periods, levels, classes, subjects, teachers] = await Promise.all([
      this.db.execute<{ id: string; label: string; active: boolean }>(sql`
        SELECT id::text, label, status = 'active' AS active FROM school_years
        WHERE status <> 'draft' ORDER BY start_date DESC`),
      this.db.execute<{ id: string; label: string; school_year_id: string; is_current: boolean; notes_entry_open: boolean; is_future: boolean; has_evaluations: boolean }>(sql`
        SELECT gp.id::text, gp.label, gp.school_year_id::text,
          CURRENT_DATE BETWEEN gp.start_date AND gp.end_date AS is_current,
          CURRENT_DATE >= gp.start_date AND CURRENT_DATE < gp.review_start_date AS notes_entry_open,
          gp.start_date > CURRENT_DATE AS is_future,
          EXISTS (SELECT 1 FROM evaluations e JOIN classes c ON c.id = e.class_id
            JOIN subjects s ON s.id = e.subject_id AND s.level_id = c.level_id
            WHERE e.grading_period_id = gp.id AND c.school_year_id = gp.school_year_id) AS has_evaluations
        FROM grading_periods gp WHERE gp.school_year_id = ${year}::uuid
        ORDER BY gp.start_date DESC, gp.order_index DESC`),
      this.db.execute<{ id: string; label: string }>(sql`
        SELECT DISTINCT l.id::text, l.name AS label FROM levels l
        JOIN classes c ON c.level_id = l.id
        WHERE c.school_year_id = ${year}::uuid ORDER BY label`),
      this.db.execute<{ id: string; label: string; level_id: string }>(sql`
        SELECT c.id::text, c.name AS label, c.level_id::text FROM classes c
        WHERE c.school_year_id = ${year}::uuid AND (${level}::uuid IS NULL OR c.level_id = ${level}::uuid)
        ORDER BY c.name`),
      this.db.execute<{ id: string; label: string; level_id: string }>(sql`
        SELECT DISTINCT s.id::text, s.name AS label, s.level_id::text FROM subjects s
        JOIN classes c ON c.level_id = s.level_id AND c.school_year_id = ${year}::uuid
        WHERE (${level}::uuid IS NULL OR c.level_id = ${level}::uuid)
          AND (${classId}::uuid IS NULL OR c.id = ${classId}::uuid)
          AND (${classId}::uuid IS NULL OR EXISTS (
            SELECT 1 FROM teacher_subject_assignments tsa WHERE tsa.class_id = c.id AND tsa.subject_id = s.id
            UNION SELECT 1 FROM evaluations e WHERE e.class_id = c.id AND e.subject_id = s.id
              AND (${period}::uuid IS NULL OR e.grading_period_id = ${period}::uuid)))
        ORDER BY label`),
      this.db.execute<{ id: string; label: string }>(sql`
        SELECT DISTINCT t.id::text, u.name AS label FROM teachers t JOIN users u ON u.id = t.user_id
        WHERE EXISTS (SELECT 1 FROM teacher_subject_assignments tsa JOIN classes c ON c.id = tsa.class_id
          WHERE tsa.teacher_id = t.id AND c.school_year_id = ${year}::uuid
            AND (${level}::uuid IS NULL OR c.level_id = ${level}::uuid)
            AND (${classId}::uuid IS NULL OR c.id = ${classId}::uuid)
            AND (${subject}::uuid IS NULL OR tsa.subject_id = ${subject}::uuid))
          OR EXISTS (SELECT 1 FROM evaluations e JOIN classes c ON c.id = e.class_id
            JOIN subjects s ON s.id = e.subject_id AND s.level_id = c.level_id
            WHERE e.teacher_id = t.id AND c.school_year_id = ${year}::uuid
              AND (${period}::uuid IS NULL OR e.grading_period_id = ${period}::uuid)
              AND (${level}::uuid IS NULL OR c.level_id = ${level}::uuid)
              AND (${classId}::uuid IS NULL OR c.id = ${classId}::uuid)
              AND (${subject}::uuid IS NULL OR e.subject_id = ${subject}::uuid))
        ORDER BY label`),
    ]);
    return {
      schoolYears: rows(years),
      gradingPeriods: rows(periods).map((p) => ({ id: p.id, label: p.label, schoolYearId: p.school_year_id,
        isCurrent: p.is_current, notesEntryOpen: p.notes_entry_open, isFuture: p.is_future, hasEvaluations: p.has_evaluations })),
      levels: rows(levels),
      classes: rows(classes).map((c) => ({ id: c.id, label: c.label, levelId: c.level_id })),
      subjects: rows(subjects).map((s) => ({ id: s.id, label: s.label, levelId: s.level_id })),
      teachers: rows(teachers),
    };
  }

  async periodBelongsToYear(periodId: string, yearId: string): Promise<boolean> {
    const result = rows(await this.db.execute<{ valid: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM grading_periods WHERE id = ${periodId}::uuid
        AND school_year_id = ${yearId}::uuid) AS valid`));
    return result[0]?.valid ?? false;
  }

  async list(query: EvaluationReviewQuery) {
    const { schoolYearId, page, pageSize } = query;
    const filter = sql`${scopeFilter(query)} AND e.type = 'scheduled'`;
    const summary = rows(await this.db.execute<{ evaluation_count: string; grade_count: string; missing_count: string }>(sql`
      WITH scoped AS (
        SELECT e.id, e.class_id FROM evaluations e JOIN classes c ON c.id = e.class_id
        JOIN subjects s ON s.id = e.subject_id WHERE ${filter}
      ), eligible AS (
        SELECT DISTINCT en.class_id, en.student_id FROM enrollments en
        JOIN students st ON st.id = en.student_id AND st.is_active = true
        JOIN classes c ON c.id = en.class_id AND c.is_active = true AND c.school_year_id = en.school_year_id
        JOIN (SELECT DISTINCT class_id FROM scoped) classes_in_scope ON classes_in_scope.class_id = en.class_id
        WHERE en.school_year_id = ${schoolYearId}::uuid AND en.status = 'confirmed'
      ), enrolled AS (
        SELECT class_id, COUNT(*) AS student_count FROM eligible GROUP BY class_id
      ), graded AS (
        SELECT eg.evaluation_id, COUNT(*) AS grade_count FROM evaluation_grades eg
        JOIN scoped e ON e.id = eg.evaluation_id
        JOIN eligible en ON en.student_id = eg.student_id AND en.class_id = e.class_id
        GROUP BY eg.evaluation_id
      )
      SELECT COUNT(*)::text AS evaluation_count, COALESCE(SUM(COALESCE(graded.grade_count, 0)), 0)::text AS grade_count,
        COALESCE(SUM(GREATEST(COALESCE(enrolled.student_count, 0) - COALESCE(graded.grade_count, 0), 0)), 0)::text AS missing_count
      FROM scoped e LEFT JOIN enrolled ON enrolled.class_id = e.class_id
      LEFT JOIN graded ON graded.evaluation_id = e.id`))[0]!;
    const evaluations = rows(await this.db.execute<{
      id: string; label: string; evaluation_date: string | null; type: 'scheduled' | 'spontaneous'; coefficient: string;
      subject_id: string; subject_name: string; teacher_id: string; teacher_name: string;
      class_id: string; class_name: string; level_id: string; level_name: string; period_id: string; period_name: string;
    }>(sql`
      SELECT e.id::text, e.label, e.evaluation_date::text, e.type::text, e.coefficient::text,
        s.id::text AS subject_id, s.name AS subject_name, t.id::text AS teacher_id, u.name AS teacher_name,
        c.id::text AS class_id, c.name AS class_name, l.id::text AS level_id, l.name AS level_name,
        gp.id::text AS period_id, gp.label AS period_name
      FROM evaluations e JOIN classes c ON c.id = e.class_id JOIN levels l ON l.id = c.level_id
      JOIN subjects s ON s.id = e.subject_id JOIN teachers t ON t.id = e.teacher_id
      JOIN users u ON u.id = t.user_id JOIN grading_periods gp ON gp.id = e.grading_period_id
      WHERE ${filter} ORDER BY e.evaluation_date DESC NULLS LAST, e.created_at DESC, e.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`));
    if (!evaluations.length) return { items: [], summary: { evaluations: Number(summary.evaluation_count), grades: Number(summary.grade_count), missing: Number(summary.missing_count) }, page, pageSize, total: Number(summary.evaluation_count) };
    const ids = evaluations.map((item) => item.id);
    const notes = rows(await this.db.execute<{
      evaluation_id: string; student_id: string; first_name: string; last_name: string;
      score: string | null; max_score: string | null; comment: string | null;
    }>(sql`
      WITH selected AS (SELECT id, class_id FROM evaluations WHERE id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[])),
      eligible AS (
        SELECT DISTINCT en.class_id, en.student_id FROM enrollments en
        JOIN students st ON st.id = en.student_id AND st.is_active = true
        JOIN classes c ON c.id = en.class_id AND c.is_active = true AND c.school_year_id = en.school_year_id
        JOIN (SELECT DISTINCT class_id FROM selected) classes_in_scope ON classes_in_scope.class_id = en.class_id
        WHERE en.school_year_id = ${schoolYearId}::uuid AND en.status = 'confirmed'
      )
      SELECT e.id::text AS evaluation_id, st.id::text AS student_id, st.first_name, st.last_name,
        eg.score::text, eg.max_score::text, eg.comment
      FROM selected e JOIN eligible en ON en.class_id = e.class_id
      JOIN students st ON st.id = en.student_id
      LEFT JOIN evaluation_grades eg ON eg.evaluation_id = e.id AND eg.student_id = st.id
      ORDER BY st.last_name, st.first_name, st.id`));
    const notesByEvaluation = new Map<string, Array<{ studentId: string; studentName: string; score: number | null; maxScore: number | null; comment: string | null }>>();
    for (const note of notes) {
      const list = notesByEvaluation.get(note.evaluation_id) ?? [];
      list.push({ studentId: note.student_id, studentName: `${note.last_name} ${note.first_name}`, score: note.score === null ? null : Number(note.score), maxScore: note.max_score === null ? null : Number(note.max_score), comment: note.comment });
      notesByEvaluation.set(note.evaluation_id, list);
    }
    return {
      items: evaluations.map((e) => ({ id: e.id, label: e.label, date: e.evaluation_date, type: e.type,
        coefficient: Number(e.coefficient), subject: { id: e.subject_id, name: e.subject_name },
        teacher: { id: e.teacher_id, name: e.teacher_name }, class: { id: e.class_id, name: e.class_name },
        level: { id: e.level_id, name: e.level_name }, period: { id: e.period_id, name: e.period_name },
        notes: notesByEvaluation.get(e.id) ?? [] })),
      summary: { evaluations: Number(summary.evaluation_count), grades: Number(summary.grade_count), missing: Number(summary.missing_count) },
      page, pageSize, total: Number(summary.evaluation_count),
    };
  }

  async listSpontaneous(query: EvaluationReviewQuery) {
    const { page, pageSize } = query;
    const filter = scopeFilter(query);
    const search = query.studentSearch ? `%${query.studentSearch}%` : null;
    const studentFilter = sql`(${search}::text IS NULL OR st.first_name ILIKE ${search}
      OR st.last_name ILIKE ${search} OR st.matricule ILIKE ${search}
      OR concat_ws(' ', st.first_name, st.last_name) ILIKE ${search}
      OR concat_ws(' ', st.last_name, st.first_name) ILIKE ${search})`;
    const total = rows(await this.db.execute<{ students: string; notes: string }>(sql`
      SELECT COUNT(DISTINCT eg.student_id)::text AS students, COUNT(*)::text AS notes
      FROM evaluations e JOIN classes c ON c.id = e.class_id
      JOIN subjects s ON s.id = e.subject_id
      JOIN evaluation_grades eg ON eg.evaluation_id = e.id
      JOIN students st ON st.id = eg.student_id
      WHERE ${filter} AND e.type = 'spontaneous' AND ${studentFilter}
        AND ${confirmedSchoolStudent(sql`st.id`, sql`c.school_year_id`, sql`c.id`)}`))[0]!;
    const students = rows(await this.db.execute<{ id: string; first_name: string; last_name: string; matricule: string | null }>(sql`
      SELECT DISTINCT st.id::text, st.first_name, st.last_name, st.matricule
      FROM evaluations e JOIN classes c ON c.id = e.class_id
      JOIN subjects s ON s.id = e.subject_id
      JOIN evaluation_grades eg ON eg.evaluation_id = e.id
      JOIN students st ON st.id = eg.student_id
      WHERE ${filter} AND e.type = 'spontaneous' AND ${studentFilter}
        AND ${confirmedSchoolStudent(sql`st.id`, sql`c.school_year_id`, sql`c.id`)}
      ORDER BY st.last_name, st.first_name, st.id::text
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`));
    if (!students.length) {
      return { students: [], totalStudents: Number(total.students), totalNotes: Number(total.notes), page, pageSize };
    }
    const ids = students.map((student) => student.id);
    const notes = rows(await this.db.execute<{
      evaluation_id: string; student_id: string; subject_id: string; subject_name: string;
      class_name: string; teacher_id: string; teacher_name: string;
      evaluation_date: string | null; adjustment: string; comment: string | null;
    }>(sql`
      SELECT e.id::text AS evaluation_id, eg.student_id::text, s.id::text AS subject_id,
        s.name AS subject_name, c.name AS class_name, t.id::text AS teacher_id,
        u.name AS teacher_name, e.evaluation_date::text,
        (CASE WHEN e.label LIKE 'Note spontanée -%' THEN -eg.score ELSE eg.score END)::text AS adjustment,
        eg.comment
      FROM evaluations e JOIN classes c ON c.id = e.class_id
      JOIN subjects s ON s.id = e.subject_id
      JOIN teachers t ON t.id = e.teacher_id JOIN users u ON u.id = t.user_id
      JOIN evaluation_grades eg ON eg.evaluation_id = e.id
      WHERE ${filter} AND e.type = 'spontaneous'
        AND ${confirmedSchoolStudent(sql`eg.student_id`, sql`c.school_year_id`, sql`c.id`)}
        AND eg.student_id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[])
      ORDER BY s.name, e.evaluation_date DESC NULLS LAST, e.created_at DESC, e.id DESC`));
    const grouped = students.map((student) => ({
      id: student.id,
      name: `${student.last_name} ${student.first_name}`,
      matricule: student.matricule,
      subjects: [] as Array<{ id: string; name: string; notes: Array<{
        evaluationId: string; date: string | null; adjustment: number; teacher: { id: string; name: string };
        className: string; comment: string | null;
      }> }>,
    }));
    const byStudent = new Map(grouped.map((student) => [student.id, student]));
    for (const note of notes) {
      const student = byStudent.get(note.student_id);
      if (!student) continue;
      let subject = student.subjects.find((item) => item.id === note.subject_id);
      if (!subject) {
        subject = { id: note.subject_id, name: note.subject_name, notes: [] };
        student.subjects.push(subject);
      }
      subject.notes.push({ evaluationId: note.evaluation_id, date: note.evaluation_date,
        adjustment: Number(note.adjustment), teacher: { id: note.teacher_id, name: note.teacher_name },
        className: note.class_name, comment: note.comment });
    }
    return { students: grouped, totalStudents: Number(total.students), totalNotes: Number(total.notes), page, pageSize };
  }
}
