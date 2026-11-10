import { sql } from 'drizzle-orm';

import { FinanceRepository, type FinanceDb } from './finance.repository.js';
import { FinancialCacheRepository } from './financial-cache.repository.js';
import { FinancialCacheService } from './financial-cache.service.js';
import { FinanceModuleError } from './finance.service.js';
import { MAX_TUITION_COPY_TARGETS, type TuitionPlanCopyInput } from './finance.types.js';

/**
 * Copie du plan de scolarité d'un niveau vers d'autres niveaux de la même année.
 *
 * - Rien n'est écrasé par défaut ; l'écrasement et l'application à des élèves déjà inscrits exigent
 *   une confirmation explicite, niveau par niveau.
 * - Chaque niveau cible est traité dans sa propre transaction (tout ou rien par niveau) : un échec
 *   n'annule pas les niveaux déjà copiés.
 * - Seuls les plans de niveau sont écrits. Les remises, montants personnalisés et échéanciers négociés
 *   des élèves (tables student_tuition_*) ne sont jamais modifiés.
 */

const rows = <T>(result: unknown): T[] =>
  typeof result === 'object' && result !== null && 'rows' in result ? ((result as { rows: T[] }).rows ?? []) : [];

export type TuitionPlanSummary = {
  totalAmount: number;
  registrationAmount: number;
  currency: string;
  scheduleSteps: Array<{ dueDate: string; cumulativeAmountExpected: number }>;
};

export type TuitionCopyTargetState = {
  levelId: string;
  levelName: string;
  /** Plan existant du niveau (sera remplacé en cas d'écrasement), sinon null. */
  existingPlan: TuitionPlanSummary | null;
  /** Élèves actifs inscrits (inscription confirmée) sur ce niveau pour l'année. */
  enrolledStudents: number;
  /** Parmi eux, ceux qui ont une remise, un montant personnalisé ou un échéancier négocié : conservés tels quels. */
  studentsWithIndividualTerms: number;
};

export type TuitionCopyPreview = {
  schoolYearId: string;
  schoolYearLabel: string;
  source: { levelId: string; levelName: string; plan: TuitionPlanSummary };
  targets: TuitionCopyTargetState[];
};

export type TuitionCopyResult =
  | { levelId: string; levelName: string; status: 'copied' }
  | { levelId: string; levelName: string; status: 'skipped'; code: 'PLAN_EXISTS' | 'ENROLLED_CONFIRMATION_REQUIRED'; message: string }
  | { levelId: string; levelName: string; status: 'error'; code: string; message: string };

type PlanRow = { total_amount: string; registration_amount: string; currency: string; steps: Array<{ dueDate: string; cumulativeAmountExpected: string | number }> | null };

const toSummary = (row: PlanRow): TuitionPlanSummary => ({
  totalAmount: Number(row.total_amount),
  registrationAmount: Number(row.registration_amount),
  currency: row.currency,
  scheduleSteps: (row.steps ?? []).map((step) => ({ dueDate: step.dueDate, cumulativeAmountExpected: Number(step.cumulativeAmountExpected) })),
});

const PLAN_SELECT = sql`
  SELECT tp.total_amount::text AS total_amount, tp.registration_amount::text AS registration_amount, tp.currency,
    COALESCE((SELECT json_agg(json_build_object('dueDate', tss.due_date::text, 'cumulativeAmountExpected', tss.cumulative_amount_expected)
      ORDER BY tss.due_date) FROM tuition_schedule_steps tss WHERE tss.tuition_plan_id = tp.id), '[]'::json) AS steps
  FROM tuition_plans tp
`;

export class TuitionPlanCopyService {
  constructor(private readonly db: FinanceDb) {}

  private async loadYear(db: FinanceDb, schoolYearId: string): Promise<{ label: string; status: string }> {
    const year = rows<{ label: string; status: string }>(await db.execute(sql`
      SELECT label, status::text AS status FROM school_years WHERE id = ${schoolYearId}::uuid
    `))[0];
    if (!year) throw new FinanceModuleError('School year not found', 404, 'TUITION_SCOPE_NOT_FOUND');
    return year;
  }

  private async loadSource(db: FinanceDb, levelId: string, schoolYearId: string) {
    const level = rows<{ name: string }>(await db.execute(sql`SELECT name FROM levels WHERE id = ${levelId}::uuid`))[0];
    if (!level) throw new FinanceModuleError('Level not found', 404, 'TUITION_SCOPE_NOT_FOUND');
    const plan = rows<PlanRow>(await db.execute(sql`${PLAN_SELECT} WHERE tp.level_id = ${levelId}::uuid AND tp.school_year_id = ${schoolYearId}::uuid`))[0];
    if (!plan) {
      throw new FinanceModuleError('Le niveau source n’a pas encore de plan de frais à copier.', 404, 'SOURCE_PLAN_NOT_FOUND');
    }
    return { levelName: level.name, plan: toSummary(plan) };
  }

  private async loadTargetStates(db: FinanceDb, schoolYearId: string, levelIds?: string[]): Promise<TuitionCopyTargetState[]> {
    const filter = levelIds ? sql`AND l.id IN (${sql.join(levelIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
    const result = await db.execute(sql`
      SELECT l.id::text AS level_id, l.name AS level_name,
        (SELECT row_to_json(plan) FROM (
          ${PLAN_SELECT} WHERE tp.level_id = l.id AND tp.school_year_id = ${schoolYearId}::uuid
        ) plan) AS plan,
        (SELECT COUNT(DISTINCT e.student_id)::int FROM enrollments e
          INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = e.school_year_id
          INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
          WHERE c.level_id = l.id AND e.school_year_id = ${schoolYearId}::uuid AND e.status = 'confirmed') AS enrolled,
        (SELECT COUNT(DISTINCT e.student_id)::int FROM enrollments e
          INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = e.school_year_id
          INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
          WHERE c.level_id = l.id AND e.school_year_id = ${schoolYearId}::uuid AND e.status = 'confirmed'
            AND (EXISTS (SELECT 1 FROM student_tuition_overrides o WHERE o.student_id = e.student_id AND o.school_year_id = e.school_year_id AND o.status = 'active')
              OR EXISTS (SELECT 1 FROM student_tuition_schedule_agreements a WHERE a.student_id = e.student_id AND a.school_year_id = e.school_year_id AND a.status = 'active'))
        ) AS individual
      FROM levels l
      WHERE true ${filter}
      ORDER BY l.order_index, l.name
    `);
    return rows<{ level_id: string; level_name: string; plan: PlanRow | null; enrolled: number; individual: number }>(result).map((row) => ({
      levelId: row.level_id,
      levelName: row.level_name,
      existingPlan: row.plan ? toSummary(row.plan) : null,
      enrolledStudents: Number(row.enrolled),
      studentsWithIndividualTerms: Number(row.individual),
    }));
  }

  /** Récapitulatif avant validation : plan source et état de chaque autre niveau. */
  async preview(sourceLevelId: string, schoolYearId: string): Promise<TuitionCopyPreview> {
    const year = await this.loadYear(this.db, schoolYearId);
    const source = await this.loadSource(this.db, sourceLevelId, schoolYearId);
    const targets = (await this.loadTargetStates(this.db, schoolYearId)).filter((target) => target.levelId !== sourceLevelId);
    return { schoolYearId, schoolYearLabel: year.label, source: { levelId: sourceLevelId, levelName: source.levelName, plan: source.plan }, targets };
  }

  async copy(sourceLevelId: string, input: TuitionPlanCopyInput): Promise<{ results: TuitionCopyResult[]; cacheRefreshed: boolean }> {
    const ids = input.targets.map((target) => target.levelId);
    if (new Set(ids).size !== ids.length || ids.includes(sourceLevelId) || ids.length > MAX_TUITION_COPY_TARGETS) {
      throw new FinanceModuleError('Les niveaux cibles doivent être distincts et différents du niveau source.', 400, 'INVALID_COPY_TARGETS');
    }
    const year = await this.loadYear(this.db, input.schoolYearId);
    if (year.status !== 'active') {
      throw new FinanceModuleError('L’année scolaire doit être ouverte par le support.', 409, 'SCHOOL_YEAR_NOT_OPEN');
    }
    const source = await this.loadSource(this.db, sourceLevelId, input.schoolYearId);

    const results: TuitionCopyResult[] = [];
    for (const target of input.targets) {
      results.push(await this.copyToLevel(source.plan, input.schoolYearId, target));
    }

    // Le cache financier (statuts, indicateurs) dérive des plans : recalculé une fois pour tous les niveaux copiés.
    let cacheRefreshed = true;
    if (results.some((result) => result.status === 'copied')) {
      try {
        await this.db.transaction(async (tx) => {
          await new FinancialCacheService(new FinancialCacheRepository(tx as FinanceDb)).recalcAll(input.schoolYearId);
        });
      } catch {
        cacheRefreshed = false;
      }
    }
    return { results, cacheRefreshed };
  }

  private async copyToLevel(plan: TuitionPlanSummary, schoolYearId: string, target: TuitionPlanCopyInput['targets'][number]): Promise<TuitionCopyResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const db = tx as FinanceDb;
        const [state] = await this.loadTargetStates(db, schoolYearId, [target.levelId]);
        if (!state) return { levelId: target.levelId, levelName: '', status: 'error', code: 'LEVEL_NOT_FOUND', message: 'Niveau introuvable.' };
        const base = { levelId: state.levelId, levelName: state.levelName };
        if (state.existingPlan && !target.overwrite) {
          return { ...base, status: 'skipped', code: 'PLAN_EXISTS', message: 'Ce niveau a déjà des frais : rien n’a été modifié.' };
        }
        if (state.enrolledStudents > 0 && !target.confirmEnrolled) {
          return {
            ...base, status: 'skipped', code: 'ENROLLED_CONFIRMATION_REQUIRED',
            message: `${state.enrolledStudents} élève(s) inscrit(s) sur ce niveau : confirmation requise, rien n’a été modifié.`,
          };
        }
        await new FinanceRepository(db).upsertTuitionPlan(target.levelId, {
          schoolYearId,
          totalAmount: plan.totalAmount,
          registrationAmount: plan.registrationAmount,
          currency: plan.currency,
          scheduleSteps: plan.scheduleSteps,
        });
        return { ...base, status: 'copied' };
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = code === 'SCHOOL_YEAR_NOT_OPEN' ? 'L’année scolaire doit être ouverte par le support.' : 'La copie a échoué : rien n’a été modifié pour ce niveau.';
      return { levelId: target.levelId, levelName: '', status: 'error', code: code ?? 'COPY_FAILED', message };
    }
  }
}

export const buildTuitionPlanCopyService = (db: FinanceDb): TuitionPlanCopyService => new TuitionPlanCopyService(db);
