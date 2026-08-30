/**
 * Seed V2 IvoirEdu — données de démonstration pour les modules V2
 * (académique 5a, conduite 5b, bulletins 5c, finance 4a, cache financier 6a).
 *
 * Prérequis : exécuter d'abord `npm run db:seed` (V1) puis ce script.
 * Idempotent : peut être relancé.
 *
 * Usage : npm run db:seed:v2
 */
import 'dotenv/config';

import pg from 'pg';
import { createTenantSchema } from './tenant-init.js';


const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const TENANT_SCHEMA = process.env.SEED_V2_SCHEMA ?? 'school_sainte_marie';
const YEAR_LABEL = '2025-2026';

type IdRow = { id: string };

/** Exécute une requête dans le schéma tenant. */
const tq = async <T extends Record<string, unknown> = IdRow>(
  query: string,
  values: unknown[] = [],
): Promise<T[]> => {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${TENANT_SCHEMA}", public`);
    const result = await client.query<T>(query, values);
    return result.rows;
  } finally {
    client.release();
  }
};

const upsertYear = async (): Promise<string> => {
  await tq(`UPDATE school_years SET status='closed' WHERE status='active'`);
  const rows = await tq<IdRow>(
    `INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status)
     VALUES ($1, '2025-09-01', '2026-06-30', '2026-05-01', 'active')
     ON CONFLICT (label) DO UPDATE SET status='active'
     RETURNING id::text`,
    [YEAR_LABEL],
  );
  return rows[0]!.id;
};

const seedGradingPeriods = async (yearId: string): Promise<Array<{ id: string; label: string }>> => {
  const defs = [
    { label: 'Trimestre 1', order: 1, start: '2025-09-01', end: '2025-12-15' },
    { label: 'Trimestre 2', order: 2, start: '2026-01-05', end: '2026-03-31' },
    { label: 'Trimestre 3', order: 3, start: '2026-04-01', end: '2026-06-30' },
  ];
  const periods: Array<{ id: string; label: string }> = [];
  for (const def of defs) {
    const rows = await tq<IdRow>(
      `INSERT INTO grading_periods (school_year_id, type, order_index, label, start_date, end_date)
       VALUES ($1::uuid, 'trimester', $2, $3, $4, $5)
       ON CONFLICT (school_year_id, label) DO NOTHING
       RETURNING id::text`,
      [yearId, def.order, def.label, def.start, def.end],
    );
    if (rows[0]) periods.push({ id: rows[0].id, label: def.label });
  }
  if (periods.length === 0) {
    return tq<{ id: string; label: string }>(
      `SELECT id::text, label FROM grading_periods WHERE school_year_id=$1::uuid ORDER BY order_index`,
      [yearId],
    );
  }
  return periods;
};

const seedLevelsAndSubjects = async (): Promise<void> => {
  for (const [index, name] of ['6ème', '5ème', '4ème', '3ème'].entries()) {
    await tq(
      `INSERT INTO levels (name, order_index, is_exam_class)
       VALUES ($1::varchar, $2::int, false) ON CONFLICT (name) DO NOTHING`,
      [name, index],
    );
  }
  const subjects: Array<[string, number]> = [
    ['Mathématiques', 4],
    ['Français', 4],
    ['Anglais', 2],
    ['Histoire-Géographie', 2],
    ['SVT', 2],
    ['Physique-Chimie', 3],
  ];
  for (const level of ['6ème', '5ème', '4ème', '3ème']) {
    for (const [name, coefficient] of subjects) {
      await tq(
        `INSERT INTO subjects (level_id, name, coefficient)
         SELECT id, $2::varchar, $3::numeric FROM levels WHERE name = $1
         ON CONFLICT (level_id, name) DO NOTHING`,
        [level, name, coefficient],
      );
    }
  }
};

type TeacherWorkspace = {
  teacherId: string;
  classIds: string[];
};

/**
 * Le seed V1 crée Mariam mais ses créneaux historiques sont répartis aléatoirement
 * et ses classes ne portent pas l'année scolaire V2. Ce parcours professeur est
 * volontairement déterministe afin que l'espace "Évaluations & notes" soit
 * directement démontrable.
 */
const seedMariamTeacherWorkspace = async (yearId: string): Promise<TeacherWorkspace> => {
  const teacherRows = await tq<IdRow>(
    `SELECT t.id::text
     FROM teachers t
     INNER JOIN users u ON u.id = t.user_id
     WHERE lower(u.email) = 'mariam.coulibaly@sainte-marie.ci'
     LIMIT 1`,
  );
  const teacherId = teacherRows[0]?.id;
  if (!teacherId) {
    throw new Error('[seed-v2] Mariam Coulibaly est absente. Exécutez d’abord npm run db:seed.');
  }

  await tq(
    `UPDATE teachers SET subjects = ARRAY['Anglais', 'Français']::text[] WHERE id = $1::uuid`,
    [teacherId],
  );

  const levelRows = await tq<IdRow>(`SELECT id::text FROM levels WHERE name = '3ème' LIMIT 1`);
  const levelId = levelRows[0]?.id;
  if (!levelId) throw new Error('[seed-v2] Niveau 3ème introuvable.');

  await tq(
    `UPDATE classes
     SET level_id = $1::uuid, school_year_id = $2::uuid, is_active = true
     WHERE name = '3ème A' AND school_year_id IS NULL`,
    [levelId, yearId],
  );
  await tq(
    `INSERT INTO classes (name, level, level_id, school_year_id, student_count, is_active)
     VALUES ('3ème A', '3ème', $1::uuid, $2::uuid, 0, true)
     ON CONFLICT (school_year_id, name) WHERE is_active = true AND school_year_id IS NOT NULL
     DO UPDATE SET level_id = EXCLUDED.level_id, level = EXCLUDED.level, is_active = true`,
    [levelId, yearId],
  );
  await tq(
    `INSERT INTO classes (name, level, level_id, school_year_id, student_count, is_active)
     VALUES ('3ème B', '3ème', $1::uuid, $2::uuid, 0, true)
     ON CONFLICT (school_year_id, name) WHERE is_active = true AND school_year_id IS NOT NULL
     DO UPDATE SET level_id = EXCLUDED.level_id, level = EXCLUDED.level, is_active = true`,
    [levelId, yearId],
  );

  const classRows = await tq<{ id: string; name: string }>(
    `SELECT id::text, name FROM classes
     WHERE school_year_id = $1::uuid AND name IN ('3ème A', '3ème B') AND is_active = true
     ORDER BY name`,
    [yearId],
  );
  if (classRows.length !== 2) throw new Error('[seed-v2] Classes de démonstration introuvables.');

  const classByName = new Map(classRows.map((row) => [row.name, row.id]));
  const classBId = classByName.get('3ème B');
  if (!classBId) throw new Error('[seed-v2] Classe 3ème B introuvable.');

  const demoStudents = [
    ['Aïcha', 'Bamba'], ['Yao', 'Kouamé'], ['Fatou', 'Kouassi'], ['Kevin', 'Traoré'],
    ['Nadia', 'Koné'], ['Issa', 'Diallo'], ['Grâce', 'Yao'], ['Moussa', 'Soro'],
  ];
  for (const [firstName, lastName] of demoStudents) {
    await tq(
      `INSERT INTO students (class_id, first_name, last_name, matricule, is_active)
       SELECT $1::uuid, $2::varchar, $3::varchar, $4::varchar, true
       WHERE NOT EXISTS (SELECT 1 FROM students WHERE matricule = $4::varchar)`,
      [classBId, firstName, lastName, `SM-3B-${firstName.toUpperCase()}`],
    );
  }
  await tq(
    `UPDATE classes c SET student_count = (SELECT count(*)::int FROM students s WHERE s.class_id = c.id AND s.is_active = true)
     WHERE c.id = ANY($1::uuid[])`,
    [classRows.map((row) => row.id)],
  );

  await tq(
    `INSERT INTO schedule_periods (name, valid_from, valid_to, is_active)
     SELECT 'Programme Mariam 2025-2026', '2025-09-01', '2026-06-30', true
     WHERE NOT EXISTS (SELECT 1 FROM schedule_periods WHERE name = 'Programme Mariam 2025-2026')`,
  );
  const schedulePeriodRows = await tq<IdRow>(
    `SELECT id::text FROM schedule_periods WHERE name = 'Programme Mariam 2025-2026' LIMIT 1`,
  );
  const schedulePeriodId = schedulePeriodRows[0]?.id;
  if (!schedulePeriodId) throw new Error('[seed-v2] Période d’emploi du temps introuvable.');

  const scheduleDefinitions = [
    { className: '3ème A', subject: 'Anglais', day: 1, startTime: '07:30' },
    { className: '3ème A', subject: 'Français', day: 2, startTime: '09:15' },
    { className: '3ème B', subject: 'Anglais', day: 3, startTime: '11:00' },
    { className: '3ème B', subject: 'Français', day: 4, startTime: '14:00' },
  ];
  for (const definition of scheduleDefinitions) {
    await tq(
      `INSERT INTO schedules (schedule_period_id, teacher_id, class_id, room_id, time_slot_id, day_of_week, subject, is_active)
       SELECT $1::uuid, $2::uuid, c.id, r.id, ts.id, $3::int, $4, true
       FROM classes c
       CROSS JOIN LATERAL (SELECT id FROM rooms WHERE is_active = true ORDER BY name LIMIT 1) r
       CROSS JOIN LATERAL (SELECT id FROM time_slots WHERE start_time = $5::time LIMIT 1) ts
       WHERE c.school_year_id = $6::uuid AND c.name = $7
       AND NOT EXISTS (
         SELECT 1 FROM schedules s WHERE s.schedule_period_id = $1::uuid AND s.teacher_id = $2::uuid
           AND s.class_id = c.id AND s.day_of_week = $3::int AND s.time_slot_id = ts.id
       )`,
      [schedulePeriodId, teacherId, definition.day, definition.subject, definition.startTime, yearId, definition.className],
    );
  }

  for (const classRow of classRows) {
    for (const subjectName of ['Anglais', 'Français']) {
      await tq(
        `INSERT INTO teacher_subject_assignments (teacher_id, subject_id, class_id)
         SELECT $1::uuid, sub.id, $2::uuid
         FROM subjects sub
         WHERE sub.level_id = $3::uuid AND sub.name = $4
         ON CONFLICT (teacher_id, subject_id, class_id) DO NOTHING`,
        [teacherId, classRow.id, levelId, subjectName],
      );
    }
  }
  return { teacherId, classIds: classRows.map((row) => row.id) };
};

const seedMariamEvaluations = async (
  teacherWorkspace: TeacherWorkspace,
  periods: Array<{ id: string; label: string }>,
): Promise<void> => {
  const periodId = periods.find((period) => period.label === 'Trimestre 1')?.id ?? periods[0]?.id;
  if (!periodId) return;
  const definitions = [
    { subject: 'Anglais', label: 'Compréhension écrite', coefficient: 2 },
    { subject: 'Français', label: 'Expression écrite', coefficient: 1 },
  ];
  for (const classId of teacherWorkspace.classIds) {
    for (const definition of definitions) {
      await tq(
        `INSERT INTO evaluations (lesson_slot_id, subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label)
         SELECT sch.id, sub.id, sch.class_id, $1::uuid, $2::uuid, 'scheduled', $3::numeric, $4::varchar
         FROM schedules sch
         INNER JOIN classes c ON c.id = sch.class_id
         INNER JOIN subjects sub ON sub.level_id = c.level_id AND sub.name = sch.subject
         WHERE sch.teacher_id = $2::uuid AND sch.class_id = $5::uuid AND sch.subject = $6::varchar
         AND NOT EXISTS (
           SELECT 1 FROM evaluations e WHERE e.teacher_id = $2::uuid AND e.class_id = $5::uuid
             AND e.grading_period_id = $1::uuid AND e.label = $4::varchar
         )
         ORDER BY sch.day_of_week, sch.created_at
         LIMIT 1`,
        [periodId, teacherWorkspace.teacherId, definition.coefficient, definition.label, classId, definition.subject],
      );
    }
  }
  await tq(
    `INSERT INTO evaluation_grades (evaluation_id, student_id, score, max_score, comment)
     SELECT e.id, s.id, 10 + (abs(hashtext(s.id::text || e.id::text)) % 11), 20, 'Saisie de démonstration'
     FROM evaluations e
     INNER JOIN students s ON s.class_id = e.class_id AND s.is_active = true
     WHERE e.teacher_id = $1::uuid AND e.grading_period_id = $2::uuid AND e.type = 'scheduled'
     ON CONFLICT (evaluation_id, student_id) DO UPDATE
     SET score = EXCLUDED.score, max_score = EXCLUDED.max_score, comment = EXCLUDED.comment`,
    [teacherWorkspace.teacherId, periodId],
  );
  await tq(
    `INSERT INTO evaluations (lesson_slot_id, subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label)
     SELECT sch.id, sub.id, sch.class_id, $1::uuid, $2::uuid, 'spontaneous', 1, 'Note spontanée +2'
     FROM schedules sch
     INNER JOIN classes c ON c.id = sch.class_id
     INNER JOIN subjects sub ON sub.level_id = c.level_id AND sub.name = sch.subject
     WHERE sch.teacher_id = $2::uuid AND sch.class_id = $3::uuid AND sch.subject = 'Anglais'
     AND NOT EXISTS (
       SELECT 1 FROM evaluations e WHERE e.teacher_id = $2::uuid AND e.class_id = $3::uuid
         AND e.grading_period_id = $1::uuid AND e.label = 'Note spontanée +2'
     )
     ORDER BY sch.day_of_week LIMIT 1`,
    [periodId, teacherWorkspace.teacherId, teacherWorkspace.classIds[0]],
  );
  await tq(
    `INSERT INTO evaluation_grades (evaluation_id, student_id, score, max_score, comment)
     SELECT e.id, s.id, 2, 20, 'Participation remarquable'
     FROM evaluations e
     INNER JOIN students s ON s.class_id = e.class_id AND s.is_active = true
     WHERE e.teacher_id = $1::uuid AND e.grading_period_id = $2::uuid AND e.label = 'Note spontanée +2'
     ORDER BY s.created_at LIMIT 3
     ON CONFLICT (evaluation_id, student_id) DO UPDATE SET score = EXCLUDED.score, comment = EXCLUDED.comment`,
    [teacherWorkspace.teacherId, periodId],
  );
};

const seedTuition = async (yearId: string): Promise<void> => {
  await tq(
    `INSERT INTO tuition_plans (level_id, school_year_id, total_amount, currency)
     SELECT l.id, $1::uuid, 300000, 'XOF' FROM levels l
     ON CONFLICT DO NOTHING`,
    [yearId],
  );
  const plans = await tq<{ id: string }>(
    `SELECT id::text FROM tuition_plans WHERE school_year_id=$1::uuid`,
    [yearId],
  );
  const steps: Array<[string, number]> = [
    ['2025-10-01', 100000],
    ['2026-01-10', 200000],
    ['2026-04-10', 300000],
  ];
  for (const plan of plans) {
    for (const [due, cumulative] of steps) {
      await tq(
        `INSERT INTO tuition_schedule_steps (tuition_plan_id, due_date, cumulative_amount_expected)
         SELECT $2::uuid, $1::date, $3::numeric
         FROM tuition_plans tp WHERE tp.id = $2::uuid
         AND NOT EXISTS (
           SELECT 1 FROM tuition_schedule_steps x
           WHERE x.tuition_plan_id = tp.id AND x.due_date = $1::date
         )`,
        [due, plan.id, cumulative],
      );
    }
  }
};

const seedConductInputs = async (periods: Array<{ id: string; label: string }>): Promise<void> => {
  // Note de conduite prof pour les premiers élèves de chaque classe (T1).
  await tq(
    `INSERT INTO teacher_conduct_inputs (student_id, teacher_id, class_id, grading_period_id, note, observation)
     SELECT s.id,
            (SELECT t.id FROM teachers t WHERE u.is_active = true ORDER BY t.created_at LIMIT 1),
            s.class_id,
            $1::uuid,
            12 + (random() * 7)::int,
            CASE WHEN random() > 0.5 THEN 'Comportement correct' ELSE 'Doit participer davantage' END
     FROM students s
     INNER JOIN users u ON true
     WHERE s.is_active = true
       AND s.class_id IN (SELECT c.id FROM classes c WHERE c.is_active = true AND c.school_year_id = (SELECT id FROM school_years WHERE status='active'))
     LIMIT 20
     ON CONFLICT DO NOTHING`,
    [periods[0]?.id],
  );
};

const seedPaymentsAndCacheTrigger = async (yearId: string): Promise<void> => {
  // Paiements de départ réalistes : la majorité à jour, quelques retards.
  const students = await tq<{ id: string }>(
    `SELECT id::text FROM students WHERE is_active = true ORDER BY created_at LIMIT 40`,
  );
  let index = 0;
  for (const student of students) {
    index += 1;
    const paid = index % 5 === 0 ? 40000 : 120000;
    await tq(
      `INSERT INTO payments (student_id, school_year_id, amount, method, source, status, payment_date, receipt_number)
       SELECT $1::uuid, $2::uuid, $3::numeric, 'cash', 'cashier_manual', 'confirmed',
              CURRENT_DATE - INTERVAL '25 days', 'SEED-' || $4::text
       FROM students s WHERE s.id = $1::uuid
       AND NOT EXISTS (
         SELECT 1 FROM payments p WHERE p.student_id = s.id AND p.receipt_number = 'SEED-' || $4::text
       )`,
      [student.id, yearId, paid, `S${index}`],
    );
  }
};

async function main(): Promise<void> {
  console.info(`[seed-v2] Schéma cible : ${TENANT_SCHEMA}`);

  // Applique les migrations tenant (idempotent) pour garantir toutes les tables V2.
  await createTenantSchema(TENANT_SCHEMA);
  console.info('[seed-v2] Migrations tenant appliquées');

  const yearId = await upsertYear();
  console.info('[seed-v2] Année scolaire active :', YEAR_LABEL);

  const periods = await seedGradingPeriods(yearId);
  console.info(`[seed-v2] ${periods.length} période(s) d'évaluation`);

  await seedLevelsAndSubjects();
  console.info('[seed-v2] Niveaux + matières avec coefficients');

  const mariamWorkspace = await seedMariamTeacherWorkspace(yearId);
  await seedMariamEvaluations(mariamWorkspace, periods);
  console.info('[seed-v2] Espace professeur Mariam Coulibaly : 2 classes, créneaux et notes');

  await seedTuition(yearId);
  console.info('[seed-v2] Plans de frais + échéanciers');

  await seedConductInputs(periods);
  console.info('[seed-v2] Notes de conduite professeurs');

  await seedPaymentsAndCacheTrigger(yearId);
  console.info('[seed-v2] Paiements de départ (le cache se recalcule au prochain job ou via un paiement)');
}

void main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch((error) => {
    console.error('[seed-v2] Échec :', error);
    process.exit(1);
  });
