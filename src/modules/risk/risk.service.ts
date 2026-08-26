import { RiskRepository } from './risk.repository.js';

export type RiskLevel = 'none' | 'attention' | 'warning' | 'critical';

/** Niveau dérivé du nombre de signaux actifs (pur). */
export const deriveLevel = (score: number): RiskLevel =>
  score <= 0 ? 'none'
  : score === 1 ? 'attention'
  : score === 2 ? 'warning'
  : 'critical';

export class RiskService {
  constructor(private readonly repository: RiskRepository) {}

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
    const threshold = rule?.thresholdValue ?? 3;
    const periodDays = rule?.periodDays && rule.periodDays > 0 ? rule.periodDays : 30;

    const counts = await this.repository.computeTeacherAbsenceCounts(periodDays);
    const teacherIds = await this.repository.listTeacherIds();

    let count = 0;
    for (const teacherId of teacherIds) {
      const absences = counts.get(teacherId) ?? 0;
      const active = rule?.isActive !== false && absences >= threshold;
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
