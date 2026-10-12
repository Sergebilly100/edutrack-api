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
