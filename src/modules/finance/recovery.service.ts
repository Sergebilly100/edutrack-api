import { computeRecoveryRate } from './financial-cache.service.js';
import { RecoveryRepository, type RecoveryClassRow } from './recovery.repository.js';

export class RecoveryError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) {
    super(message);
  }
}

export type RecoveryMetrics = {
  studentCount: number; expected: number; paid: number; waived: number;
  remaining: number; recoveryRate: number; studentsToFollow: number;
};

export const summarizeRecovery = (rows: readonly RecoveryClassRow[]): RecoveryMetrics => {
  const totals = rows.reduce((sum, row) => ({
    studentCount: sum.studentCount + Number(row.student_count),
    expected: sum.expected + Number(row.expected),
    paid: sum.paid + Number(row.paid),
    waived: sum.waived + Number(row.waived),
    remaining: sum.remaining + Number(row.remaining),
    studentsToFollow: sum.studentsToFollow + Number(row.students_to_follow),
  }), { studentCount: 0, expected: 0, paid: 0, waived: 0, remaining: 0, studentsToFollow: 0 });
  return { ...totals, recoveryRate: computeRecoveryRate(totals.paid, totals.expected) };
};

export class RecoveryService {
  constructor(private readonly repository: RecoveryRepository) {}

  async getYears() {
    return { years: await this.repository.listYears() };
  }

  private async validate(yearId: string, levelId?: string, classId?: string): Promise<void> {
    if (!(await this.repository.yearExists(yearId))) {
      throw new RecoveryError('School year not found', 404, 'SCHOOL_YEAR_NOT_FOUND');
    }
    if (levelId && !(await this.repository.levelExists(levelId, yearId))) {
      throw new RecoveryError('Level is outside this school year', 400, 'RECOVERY_LEVEL_OUT_OF_SCOPE');
    }
    if (classId && !(await this.repository.classExists(classId, yearId, levelId))) {
      throw new RecoveryError('Class is outside this school year or level', 400, 'RECOVERY_CLASS_OUT_OF_SCOPE');
    }
  }

  async getSummary(yearId: string, levelId?: string, classId?: string) {
    await this.validate(yearId, levelId, classId);
    const allClasses = await this.repository.listClasses(yearId);
    const classes = allClasses.filter((row) =>
      (!levelId || row.level_id === levelId) && (!classId || row.class_id === classId));
    const levels = [...new Set(classes.map((row) => row.level_id))].map((id) => {
      const levelClasses = classes.filter((row) => row.level_id === id);
      return { levelId: id, levelName: levelClasses[0]!.level_name, ...summarizeRecovery(levelClasses) };
    });
    return {
      schoolYearId: yearId,
      school: summarizeRecovery(allClasses),
      selection: summarizeRecovery(classes),
      levels,
      classes: classes.map((row) => ({
        classId: row.class_id, className: row.class_name,
        levelId: row.level_id, levelName: row.level_name,
        ...summarizeRecovery([row]),
      })),
    };
  }

  async getClassStudents(yearId: string, classId: string, levelId: string | undefined, page: number, limit: number) {
    await this.validate(yearId, levelId, classId);
    const total = await this.repository.countClassStudents(yearId, classId);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const currentPage = Math.min(page, totalPages);
    const students = await this.repository.listClassStudents(yearId, classId, limit, (currentPage - 1) * limit);
    return {
      students: students.map((row) => ({
        studentId: row.student_id, name: row.full_name, matricule: row.matricule,
        status: row.status, expected: Number(row.expected), paid: Number(row.paid),
        waived: Number(row.waived), remaining: Number(row.remaining), daysLate: row.days_late,
      })),
      pagination: { page: currentPage, limit, total, totalPages },
    };
  }
}
