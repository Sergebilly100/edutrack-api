import { civilMonthSchema, civilWeekSchema } from '../../shared/utils/date-validation.js';
import { z } from 'zod';

export const parentLoginSchema = z.object({
  phone: z.string().trim().regex(/^225\d{10}$/),
  password: z.string().min(1),
});

export const parentStudentIdParamsSchema = z.object({
  studentId: z.string().uuid(),
});

export const parentScheduleQuerySchema = z.object({
  week: civilWeekSchema,
});

export const parentAbsencesQuerySchema = z.object({
  month: civilMonthSchema,
});

export const parentGradesQuerySchema = z.object({
  gradingPeriodId: z.string().uuid().optional(),
});

export const parentChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z
    .string()
    .min(8, 'Le mot de passe doit contenir au moins 8 caractères')
    .regex(/[A-Z]/, 'Le mot de passe doit contenir au moins une majuscule')
    .regex(/[0-9]/, 'Le mot de passe doit contenir au moins un chiffre'),
});

export const parentNotificationParamsSchema = z.object({
  notificationId: z.string().uuid(),
});

export const parentNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ParentStudentSummary = {
  id: string;
  first_name: string;
  last_name: string;
  class_name: string;
};

export type ParentSubscriptionStatus = 'active' | 'expired' | 'cancelled';

export type ParentNotification = {
  id: string;
  type: 'payment_reminder';
  message: string;
  createdAt: string;
  readAt: string | null;
  studentId: string | null;
  studentName: string | null;
};

export type ParentGradePeriod = {
  id: string;
  label: string;
  isCurrent: boolean;
};

export type ParentGradeEvaluation = {
  id: string;
  label: string;
  date: string | null;
  type: 'scheduled' | 'spontaneous';
  coefficient: number;
  score: number;
  maxScore: number;
};

export type ParentGradeSubject = {
  id: string;
  name: string;
  average: number | null;
  evaluations: ParentGradeEvaluation[];
};

export type ParentGradesResponse = {
  schoolYear: { id: string; label: string };
  periods: ParentGradePeriod[];
  selectedGradingPeriodId: string | null;
  subjects: ParentGradeSubject[];
  conductGrade: number | null;
  resultsInRevision: boolean;
};
