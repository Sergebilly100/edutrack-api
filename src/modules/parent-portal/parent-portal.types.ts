import { z } from 'zod';

export const parentLoginSchema = z.object({
  phone: z.string().trim().regex(/^225\d{10}$/),
  password: z.string().min(1),
});

export const parentStudentIdParamsSchema = z.object({
  studentId: z.string().uuid(),
});

export const parentScheduleQuerySchema = z.object({
  week: z.string().regex(/^\d{4}-W\d{2}$/),
});

export const parentAbsencesQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

export const parentChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z
    .string()
    .min(8, 'Le mot de passe doit contenir au moins 8 caractères')
    .regex(/[A-Z]/, 'Le mot de passe doit contenir au moins une majuscule')
    .regex(/[0-9]/, 'Le mot de passe doit contenir au moins un chiffre'),
});

export type ParentStudentSummary = {
  id: string;
  first_name: string;
  last_name: string;
  class_name: string;
};

export type ParentSubscriptionStatus = 'active' | 'expired' | 'cancelled';
