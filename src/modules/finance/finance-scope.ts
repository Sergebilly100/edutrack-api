import type { SQL } from 'drizzle-orm';
import { confirmedSchoolStudent } from '../../shared/database/confirmed-school-membership.js';

/** The only membership rule for a student's financial year. */
export const confirmedFinancialStudent = (studentId: SQL, schoolYearId: SQL): SQL =>
  confirmedSchoolStudent(studentId, schoolYearId);
