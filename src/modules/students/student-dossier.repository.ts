import { sql } from 'drizzle-orm';

import type { TenantDb } from '../../shared/database/db.js';

type Rows<T> = { rows?: T[] };

export type DossierEvent = {
  type: 'enrollment' | 'payment' | 'report_card' | 'absence' | 'document';
  date: string;
  label: string;
  detail: string | null;
};

/**
 * Dossier élève (Tâche 7c) : timeline chronologique en lecture seule,
 * agrégeant inscriptions, paiements, bulletins publiés, absences et documents.
 * Volume faible par élève : pas de cache nécessaire.
 */
export class StudentDossierRepository {
  constructor(readonly db: TenantDb) {}

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
