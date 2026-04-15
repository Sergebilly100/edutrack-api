import { z } from 'zod';

export const monthQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

export const teacherParamsSchema = z.object({
  teacherId: z.string().uuid(),
});

export const recordParamsSchema = z.object({
  recordId: z.string().uuid(),
});

export const jobParamsSchema = z.object({
  jobId: z.string().min(1).max(128),
});

export const updateSalaryStatusBodySchema = z.object({
  status: z.enum(['paid', 'disputed']),
  notes: z.string().trim().max(2000).optional(),
});

export type SalaryMonthQuery = z.infer<typeof monthQuerySchema>;
export type SalaryTeacherParams = z.infer<typeof teacherParamsSchema>;
export type SalaryRecordParams = z.infer<typeof recordParamsSchema>;
export type SalaryJobParams = z.infer<typeof jobParamsSchema>;
export type UpdateSalaryStatusBody = z.infer<typeof updateSalaryStatusBodySchema>;
