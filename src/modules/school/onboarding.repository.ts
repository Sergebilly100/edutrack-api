import { sql } from 'drizzle-orm';
import type { TenantDb } from '../../shared/database/db.js';

export type OnboardingState = {
  schoolId: string;
  schoolInfoComplete: boolean;
  activeYear: boolean;
  levels: boolean;
  subjects: boolean;
  rooms: boolean;
  fees: boolean;
  teachers: boolean;
};

export class OnboardingRepository {
  constructor(private readonly db: TenantDb) {}

  async readState(schemaName: string): Promise<OnboardingState> {
    const result = await this.db.execute<OnboardingState>(sql`
      SELECT t.id::text AS "schoolId",
        (length(trim(t.name)) >= 2 AND length(trim(COALESCE(t.address, ''))) >= 3
          AND length(trim(COALESCE((SELECT phone FROM users WHERE role = 'director'
            ORDER BY created_at ASC LIMIT 1), ''))) >= 6) AS "schoolInfoComplete",
        EXISTS (SELECT 1 FROM school_years WHERE status = 'active') AS "activeYear",
        EXISTS (SELECT 1 FROM levels) AS levels,
        EXISTS (SELECT 1 FROM subjects) AS subjects,
        EXISTS (SELECT 1 FROM rooms WHERE is_active = true) AS rooms,
        EXISTS (SELECT 1 FROM tuition_plans tp JOIN school_years sy ON sy.id = tp.school_year_id
          WHERE sy.status = 'active') AS fees,
        EXISTS (SELECT 1 FROM teachers teacher JOIN users u ON u.id = teacher.user_id
          WHERE u.is_active = true) AS teachers
      FROM public.tenants t WHERE t.schema_name = ${schemaName} LIMIT 1
    `);
    const state = result.rows[0];
    if (!state) throw new Error('Tenant not found');
    return state;
  }

  async markCompleted(schoolId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE public.tenants SET onboarding_completed = true, updated_at = NOW()
      WHERE id = ${schoolId}::uuid
    `);
  }

  // Validate and persist using the same tenant connection and transaction snapshot.
  async transaction<T>(work: (repository: OnboardingRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(new OnboardingRepository(tx as TenantDb)), {
      isolationLevel: 'serializable',
    });
  }
}
