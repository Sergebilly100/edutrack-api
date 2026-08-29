import { sql } from 'drizzle-orm';

import type { TenantDb } from '../../shared/database/db.js';

export type DossierEvent = {
  type: 'enrollment' | 'payment' | 'report_card' | 'absence' | 'document';
  date: string;
  label: string;
  detail: string | null;
};

export type StudentDossierProfile = {
  id: string;
  firstName: string;
  lastName: string;
  className: string;
  matricule: string | null;
};

/**
 * Dossier élève (Tâche 7c) : timeline chronologique en lecture seule,
 * agrégeant inscriptions, paiements, bulletins publiés, absences et documents.
 * Volume faible par élève : pas de cache nécessaire.
 */
export class StudentDossierRepository {
  constructor(readonly db: TenantDb) {}

  async findStudentProfile(studentId: string): Promise<StudentDossierProfile | null> {
    const result = await this.db.execute<{
      id: string;
      first_name: string;
      last_name: string;
      class_name: string;
      matricule: string | null;
    }>(sql`
      SELECT s.id::text, s.first_name, s.last_name, c.name AS class_name, s.matricule
      FROM students s
      INNER JOIN classes c ON c.id = s.class_id
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
        INNER JOIN schedules s ON s.class_id = st.class_id
        INNER JOIN schedule_periods sp ON sp.id = s.schedule_period_id
        WHERE st.id = ${studentId}::uuid
          AND s.teacher_id = ${teacherId}::uuid
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
      type: string; date: string; label: string; detail: string | null;
    }>(sql`
      WITH events AS (
        SELECT e.enrolled_at::date AS date,
               'enrollment' AS type,
               concat('Inscription ', COALESCE(e.status::text, ''), ' · ', COALESCE(sy.label, '')) AS label,
               NULL::text AS detail
        FROM enrollments e
        LEFT JOIN school_years sy ON sy.id = e.school_year_id
        WHERE e.student_id = ${studentId}::uuid
          AND (${teacherId}::uuid IS NULL)

        UNION ALL
        SELECT p.payment_date::date,
               'payment',
               concat('Paiement ', p.amount::text, ' FCFA'),
               concat_ws(' - ', p.method::text, p.provider_reference)
        FROM payments p
        WHERE p.student_id = ${studentId}::uuid AND p.status = 'confirmed'
          AND (${teacherId}::uuid IS NULL)

        UNION ALL
        SELECT rc.published_at::date,
               'report_card',
               concat('Bulletin publié · ', gp.label),
               concat('Moyenne ', rc.general_average::text, '/20, rang ', rc.rank::text, '/', rc.class_headcount::text)
        FROM report_cards rc
        INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id
        WHERE rc.student_id = ${studentId}::uuid AND rc.status = 'published'
          AND (${teacherId}::uuid IS NULL)

        UNION ALL
        SELECT ast.date::date,
               'absence',
               CASE ast.status WHEN 'excused' THEN 'Absence justifiée' ELSE 'Absence' END,
               s.subject
        FROM attendances_student ast
        INNER JOIN schedules s ON s.id = ast.schedule_id
        WHERE ast.student_id = ${studentId}::uuid
          AND ast.status IN ('absent', 'excused')
          AND (${teacherId}::uuid IS NULL OR s.teacher_id = ${teacherId}::uuid)

        UNION ALL
        SELECT sd.created_at::date,
               'document',
               COALESCE(rdt.name, 'Document'),
               CASE WHEN sd.file_url IS NOT NULL THEN 'fourni' ELSE 'manquant' END
        FROM student_documents sd
        LEFT JOIN required_document_types rdt ON rdt.id = sd.document_type_id
        WHERE sd.student_id = ${studentId}::uuid
          AND (${teacherId}::uuid IS NULL)
      )
      SELECT type, date::text, label, detail FROM events ORDER BY date DESC LIMIT 200
    `);
    return (result.rows ?? []) as DossierEvent[];
  }
}
