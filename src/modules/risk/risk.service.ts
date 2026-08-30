import { RiskRepository, type RiskRule } from './risk.repository.js';
import {
  DEFAULT_RISK_RULES,
  isAbsenceRisk,
  resolveRollingRiskRule,
} from './risk.calculations.js';

export type RiskLevel = 'none' | 'attention' | 'warning' | 'critical';

/** Niveau dérivé du nombre de signaux actifs (pur). */
export const deriveLevel = (score: number): RiskLevel =>
  score <= 0 ? 'none'
  : score === 1 ? 'attention'
  : score === 2 ? 'warning'
  : 'critical';

export class RiskService {
  constructor(private readonly repository: RiskRepository) {}

  listRules(): Promise<RiskRule[]> {
    return this.repository.listRules();
  }

  upsertRule(input: Omit<RiskRule, 'id'>): Promise<void> {
    return this.repository.upsertRule(input);
  }

  /** Recalcul complet : élèves puis profs. Appelé par le job 15 min partagé. */
  async recalculateAll(): Promise<{ students: number; teachers: number }> {
    const students = await this.recalculateStudents();
    const teachers = await this.recalculateTeachers();
    return { students, teachers };
  }

  async recalculateStudents(): Promise<number> {
    const signals = await this.repository.computeStudentSignals();
    const studentIds = await this.repository.listStudentIds();

    let count = 0;
    for (const studentId of studentIds) {
      const signal = signals.get(studentId) ?? {
        absences: { count: 0, active: false },
        grades: { drop: null, active: false },
        payments: false,
      };
      const score =
        (signal.absences.active ? 1 : 0) +
        (signal.grades.active ? 1 : 0) +
        (signal.payments ? 1 : 0);
      await this.repository.upsertStudentRisk({
        studentId,
        absencesSignal: signal.absences.active,
        gradesSignal: signal.grades.active,
        paymentSignal: signal.payments,
        riskScore: score,
        level: deriveLevel(score),
      });
      count += 1;
    }
    return count;
  }

  async recalculateTeachers(): Promise<number> {
    const rules = await this.repository.listRules();
    const rule = rules.find((r) => r.subjectType === 'teacher' && r.signalType === 'absences');
    const ruleConfig = resolveRollingRiskRule(rule, DEFAULT_RISK_RULES.teacherAbsences);

    const counts = await this.repository.computeTeacherAbsenceCounts(ruleConfig.periodDays);
    const teacherIds = await this.repository.listTeacherIds();

    let count = 0;
    for (const teacherId of teacherIds) {
      const absences = counts.get(teacherId) ?? 0;
      const active = isAbsenceRisk(
        absences,
        ruleConfig.thresholdValue,
        ruleConfig.isActive
      );
      const score = active ? 1 : 0;
      await this.repository.upsertTeacherRisk({
        teacherId,
        absencesSignal: active,
        riskScore: score,
        level: deriveLevel(score),
      });
      count += 1;
    }
    return count;
  }
}

export const buildRiskService = (db: ConstructorParameters<typeof RiskRepository>[0]) =>
  new RiskService(new RiskRepository(db));
