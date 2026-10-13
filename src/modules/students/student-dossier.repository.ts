import { sql } from 'drizzle-orm';
import { confirmedSchoolStudent } from '../../shared/database/confirmed-school-membership.js';
import { visibleReportCardRank } from '../../shared/database/report-card-visible-rank.js';
import { formatStudentRankWithHeadcount } from '../../shared/utils/format-student-rank.js';

import type { TenantDb } from '../../shared/database/db.js';

export type DossierEvent = {
  type: 'enrollment' | 'payment' | 'report_card' | 'document';
  date: string;
  label: string;
  detail: string | null;
  schoolYearId: string | null;
};

export type StudentDossierProfile = {
  id: string;
  firstName: string;
  lastName: string;
  className: string | null;
  matricule: string | null;
};

/**
 * Dossier élève (Tâche 7c) : timeline chronologique en lecture seule,
 * agrégeant inscriptions, paiements, bulletins publiés et documents.
 * Volume faible par élève : pas de cache nécessaire.
 */
export class StudentDossierRepository {
  constructor(readonly db: TenantDb) {}

  async findStudentProfile(studentId: string): Promise<StudentDossierProfile | null> {
    const result = await this.db.execute<{
      id: string;
      first_name: string;
      last_name: string;
      class_name: string | null;
      matricule: string | null;
    }>(sql`
      SELECT s.id::text, s.first_name, s.last_name, c.name AS class_name, s.matricule
      FROM students_with_class s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.id = ${studentId}::uuid
      LIMIT 1
    `);
    const row = result.rows?.[0];
    if (!row) return null;
    return {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      className: row.class_name,
      matricule: row.matricule,
    };
  }

  async findTeacherIdByUserId(userId: string): Promise<string | null> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM teachers WHERE user_id = ${userId}::uuid LIMIT 1
    `);
    return result.rows?.[0]?.id ?? null;
  }

  async teacherCanAccessStudent(teacherId: string, studentId: string, date: string): Promise<boolean> {
    const result = await this.db.execute<{ has_access: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM students st
        INNER JOIN schedules s ON true
        INNER JOIN classes c ON c.id = s.class_id
        INNER JOIN schedule_periods sp ON sp.id = s.schedule_period_id
        WHERE st.id = ${studentId}::uuid
          AND s.teacher_id = ${teacherId}::uuid
          AND ${confirmedSchoolStudent(sql`st.id`, sql`c.school_year_id`, sql`c.id`)}
          AND s.is_active = true
          AND (s.start_date IS NULL OR s.start_date <= ${date}::date)
          AND (s.end_date IS NULL OR s.end_date >= ${date}::date)
          AND sp.is_active = true
          AND sp.valid_from <= ${date}::date
          AND sp.valid_to >= ${date}::date
          AND NOT EXISTS (
            SELECT 1 FROM schedule_exceptions se
            WHERE se.schedule_id = s.id AND se.exception_date = ${date}::date
          )
        LIMIT 1
      ) AS has_access
    `);
    return result.rows?.[0]?.has_access ?? false;
  }

  async listEvents(studentId: string, teacherId: string | null): Promise<DossierEvent[]> {
    const result = await this.db.execute<{
      type: DossierEvent['type']; date: string; label: string; detail: string | null;
      schoolYearId: string | null; rank: number | null; classHeadcount: number | null;
    }>(sql`
      WITH events AS (
        SELECT e.enrolled_at::date AS date,
               'enrollment' AS type,
               concat('Inscription ', COALESCE(e.status::text, ''), ' · ', COALESCE(sy.label, '')) AS label,
               NULL::text AS detail,
               e.school_year_id::text AS "schoolYearId",
               NULL::integer AS rank, NULL::integer AS "classHeadcount"
        FROM enrollments e
        LEFT JOIN school_years sy ON sy.id = e.school_year_id
        WHERE e.student_id = ${studentId}::uuid
          AND (${teacherId}::uuid IS NULL)

        UNION ALL
        SELECT p.payment_date::date,
               'payment',
               concat('Paiement ', p.amount::text, ' FCFA'),
               concat_ws(' - ', p.method::text, p.provider_reference),
               p.school_year_id::text,
               NULL::integer, NULL::integer
        FROM payments p
        WHERE p.student_id = ${studentId}::uuid AND p.status = 'confirmed'
          AND (${teacherId}::uuid IS NULL)

        UNION ALL
        SELECT rc.published_at::date,
               'report_card',
               concat('Bulletin publié · ', gp.label),
               concat('Moyenne ', rc.general_average::text, '/20'),
               gp.school_year_id::text,
               ${visibleReportCardRank}, rc.class_headcount
        FROM report_cards rc
        INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id
        WHERE rc.student_id = ${studentId}::uuid AND rc.status = 'published'
          AND (${teacherId}::uuid IS NULL)

        UNION ALL
        SELECT sd.created_at::date,
               'document',
               COALESCE(rdt.name, 'Document'),
               CASE WHEN sd.file_url IS NOT NULL THEN 'fourni' ELSE 'manquant' END,
               NULL::text,
               NULL::integer, NULL::integer
        FROM student_documents sd
        LEFT JOIN required_document_types rdt ON rdt.id = sd.document_type_id
        WHERE sd.student_id = ${studentId}::uuid
          AND (${teacherId}::uuid IS NULL)

        UNION ALL
        SELECT d.created_at::date,
               'document',
               d.name,
               'fourni',
               NULL::text,
               NULL::integer, NULL::integer
        FROM documents d
        WHERE d.entity_type = 'student'::document_entity_type
          AND d.entity_id = ${studentId}::uuid
          AND (${teacherId}::uuid IS NULL)
      )
      SELECT type, date::text, label, detail, "schoolYearId", rank, "classHeadcount"
      FROM events ORDER BY date DESC LIMIT 200
    `);
    return (result.rows ?? []).map(({ rank, classHeadcount, ...event }) => {
      if (event.type !== 'report_card') return event;
      const rankLabel = formatStudentRankWithHeadcount(rank, classHeadcount);
      return { ...event, detail: `${event.detail ?? ''}, rang ${rankLabel ?? 'non renseigné'}` };
    });
  }
}
