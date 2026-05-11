import { z } from 'zod';

export const dashboardStatsQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .default(() => new Date().toISOString().slice(0, 10)),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
    .default(() => new Date().toISOString().slice(0, 7)),
});

export type DashboardStatsQuery = z.infer<typeof dashboardStatsQuerySchema>;

export type TeacherAttendanceStats = {
  globalRate: number;
  partTime: {
    rate: number;
    present: number;
    expected: number;
  };
  fullTime: {
    rate: number;
    present: number;
    expected: number;
  };
};

export type StudentAttendanceStats = {
  rate: number;
  present: number;
  absent: number;
  notMarked: number;
  total: number;
};

export type SalaryStats = {
  monthlyTotal: number;
  toPayCurrentPeriod: number;
  totalPaid: number;
  remainingToPay: number;
  economy: {
    label: string;
    plannedHours: number;
    completedHours: number;
    savedAmount: number;
  };
};

export type SubscriptionStats = {
  isEnabled: boolean;
  collectedAmount: number;
  activeSubscribers: number;
  collectionRate: number;
  expectedAmount: number;
};

export type DashboardStats = {
  teacherAttendance: TeacherAttendanceStats;
  studentAttendance: StudentAttendanceStats;
  salaries: SalaryStats;
  subscriptions: SubscriptionStats;
};
