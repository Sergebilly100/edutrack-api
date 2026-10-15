import 'dotenv/config';

import { Pool } from 'pg';

type WaiverRow = {
  id: string;
  student_id: string;
  school_year_id: string;
  amount: string;
  source: string;
  receipt_number: string;
  confirmed_by_user_id: string | null;
  created_at: Date;
  override_count: number;
  individual_schedule_count: number;
  confirmed_payment_count: number;
  confirmed_paid: string;
};

type WaiverPlan = {
  schema: string;
  rows: WaiverRow[];
  students: Array<{
    studentId: string;
    schoolYearId: string;
    amount: number;
    grantedByUserId: string;
    grantedAt: Date;
  }>;
};

const schemaIsSafe = (schema: string): boolean => /^school_[a-z0-9_]{1,56}$/.test(schema);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (args.some((argument) => argument !== '--apply')) {
    throw new Error('Usage: npm run finance:prepare-waiver-removal [-- --apply]');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenants = await client.query<{ schema_name: string }>(
      'SELECT schema_name FROM public.tenants ORDER BY schema_name'
    );
    const plans: WaiverPlan[] = [];

    for (const { schema_name: schema } of tenants.rows) {
      if (!schemaIsSafe(schema)) throw new Error(`INVALID_TENANT_SCHEMA: ${schema}`);
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      const result = await client.query<WaiverRow>(`
        SELECT p.id::text, p.student_id::text, p.school_year_id::text,
               p.amount::text, p.source, p.receipt_number, p.confirmed_by_user_id::text,
               p.created_at,
               COALESCE((SELECT COUNT(*) FROM student_tuition_overrides o
                 WHERE o.student_id = p.student_id AND o.school_year_id = p.school_year_id), 0)::int AS override_count,
               COALESCE((SELECT COUNT(*) FROM student_tuition_schedule_steps s
                 WHERE s.student_id = p.student_id AND s.school_year_id = p.school_year_id), 0)::int AS individual_schedule_count,
               COALESCE((SELECT COUNT(*) FROM payments cp WHERE cp.student_id = p.student_id
                 AND cp.school_year_id = p.school_year_id AND cp.status = 'confirmed'), 0)::int AS confirmed_payment_count,
               COALESCE((SELECT SUM(cp.amount) FROM payments cp WHERE cp.student_id = p.student_id
                 AND cp.school_year_id = p.school_year_id AND cp.status = 'confirmed'), 0)::numeric(14,2)::text AS confirmed_paid
        FROM payments p
        WHERE p.status = 'waived_by_school'
        ORDER BY p.school_year_id, p.student_id, p.id
        ${apply ? 'FOR UPDATE' : ''}
      `);
      if (result.rows.length === 0) continue;

      const rows = result.rows;
      const validDemo = schema.startsWith('school_demo_') && rows.every((row) =>
        row.source === 'cashier_manual'
        && /^DEMO-[0-9]+-TOL$/.test(row.receipt_number)
        && row.confirmed_by_user_id !== null
        && row.override_count === 0
        && row.individual_schedule_count === 0
      );
      if (!validDemo) {
        throw new Error(`WAIVER_RECONCILIATION_REQUIRED: ${schema}; UUID-only inventory: ${JSON.stringify(rows.map((row) => ({
          studentId: row.student_id,
          schoolYearId: row.school_year_id,
          amount: row.amount,
          source: row.source,
          overrideCount: row.override_count,
          individualScheduleCount: row.individual_schedule_count,
          confirmedPaymentCount: row.confirmed_payment_count,
          confirmedPaid: row.confirmed_paid,
        })))}`);
      }

      const byStudent = new Map<string, WaiverPlan['students'][number]>();
      for (const row of rows) {
        const key = `${row.student_id}:${row.school_year_id}`;
        const current = byStudent.get(key);
        if (current && current.grantedByUserId !== row.confirmed_by_user_id) {
          throw new Error(`DEMO_DISCOUNT_AUTHOR_CONFLICT: ${schema}:${row.student_id}`);
        }
        byStudent.set(key, {
          studentId: row.student_id,
          schoolYearId: row.school_year_id,
          amount: (current?.amount ?? 0) + Number(row.amount),
          grantedByUserId: row.confirmed_by_user_id!,
          grantedAt: current?.grantedAt ?? row.created_at,
        });
      }
      plans.push({ schema, rows, students: [...byStudent.values()] });
    }

    const report = plans.map(({ schema, rows, students }) => ({
      schema,
      paymentCount: rows.length,
      studentYearCount: students.length,
      amount: rows.reduce((sum, row) => sum + Number(row.amount), 0),
      records: students.map((student) => ({ studentId: student.studentId, schoolYearId: student.schoolYearId, discountAmount: student.amount })),
    }));
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', tenantCount: tenants.rows.length, affectedTenants: report }, null, 2));

    if (apply) {
      for (const plan of plans) {
        await client.query(`SET LOCAL search_path TO "${plan.schema}", public`);
        for (const student of plan.students) {
          await client.query(`
            INSERT INTO student_tuition_overrides (
              student_id, school_year_id, discount_amount, reason, granted_by_user_id, created_at
            ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)
          `, [student.studentId, student.schoolYearId, student.amount,
            'Remise sociale de démonstration documentée (scénario C43)', student.grantedByUserId, student.grantedAt]);
        }
        await client.query("DELETE FROM payments WHERE status = 'waived_by_school' AND receipt_number LIKE 'DEMO-%-TOL'");
      }
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Financial waiver preflight failed');
  process.exitCode = 1;
});
