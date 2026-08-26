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
