import { z } from 'zod';

const monthRegex = /^\d{4}-\d{2}$/;

export const monthQuerySchema = z.object({
  month: z.string().regex(monthRegex),
});

export const teacherParamsSchema = z.object({
  teacherId: z.string().uuid(),
});

export const salaryHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).optional().default(24),
  offset: z.coerce.number().int().min(0).optional().default(0),
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
  hoursToPay: z.number().positive().max(744).optional(),
});

export const salarySingleExportBodySchema = z.object({
  teacherId: z.string().uuid(),
  periodMonth: z.string().regex(monthRegex),
});

export const salaryBulkExportBodySchema = z
  .object({
    teacherId: z.string().uuid().optional().nullable(),
    periodFrom: z.string().regex(monthRegex),
    periodTo: z.string().regex(monthRegex),
  })
  .refine((value) => value.periodFrom <= value.periodTo, {
    message: 'periodFrom must be before or equal to periodTo',
    path: ['periodFrom'],
  });

export const paymentHistoryExportBodySchema = z
  .object({
    teacherId: z.string().uuid(),
    periodFrom: z.string().regex(monthRegex),
    periodTo: z.string().regex(monthRegex),
  })
  .refine((value) => value.periodFrom <= value.periodTo, {
    message: 'periodFrom must be before or equal to periodTo',
    path: ['periodFrom'],
  });

export const jobDownloadQuerySchema = z.object({
  expires: z.coerce.number().int().positive(),
  signature: z.string().trim().min(32).max(256),
  uid: z.string().trim().uuid(),
});

export type SalaryMonthQuery = z.infer<typeof monthQuerySchema>;
export type SalaryTeacherParams = z.infer<typeof teacherParamsSchema>;
export type SalaryHistoryQuery = z.infer<typeof salaryHistoryQuerySchema>;
export type SalaryRecordParams = z.infer<typeof recordParamsSchema>;
export type SalaryJobParams = z.infer<typeof jobParamsSchema>;
export type UpdateSalaryStatusBody = z.infer<typeof updateSalaryStatusBodySchema>;
export type SalarySingleExportBody = z.infer<typeof salarySingleExportBodySchema>;
export type SalaryBulkExportBody = z.infer<typeof salaryBulkExportBodySchema>;
export type PaymentHistoryExportBody = z.infer<typeof paymentHistoryExportBodySchema>;
export type JobDownloadQuery = z.infer<typeof jobDownloadQuerySchema>;

export const recalculateSalaryBodySchema = z.object({
  month: z.string().regex(monthRegex),
  teacher_id: z.string().uuid().optional(),
});

