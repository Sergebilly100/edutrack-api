import type { TenantDb } from '../../shared/database/db.js';
import { buildDashboardRepository } from './dashboard.repository.js';
import type { DashboardStats } from './dashboard.types.js';

export function buildDashboardService(db: TenantDb) {
  const repository = buildDashboardRepository(db);

  /**
   * Récupère toutes les stats dashboard pour une date et un mois donnés
   */
  async function getStats(date: string, month: string): Promise<DashboardStats> {
    const [teacherAttendance, studentAttendance, salaries, subscriptions] = await Promise.all([
      repository.getTeacherAttendanceForDay(date),
      repository.getStudentAttendanceForDay(date),
      repository.getSalaryStatsForMonth(month, date),
      repository.getSubscriptionStatsForMonth(month),
    ]);

    return {
      teacherAttendance,
      studentAttendance,
      salaries,
      subscriptions,
    };
  }

  return {
    getStats,
  };
}

export type DashboardService = ReturnType<typeof buildDashboardService>;
