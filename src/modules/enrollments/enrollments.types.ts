import { z } from 'zod';
import { confirmEnrollmentPaymentBodySchema } from '../finance/finance.types.js';

export { confirmEnrollmentPaymentBodySchema };

export const enrollmentTypeSchema = z.enum(['new_registration', 're_registration']);
export const enrollmentStatusSchema = z.enum([
  'pending_cashier',
  'pending_dossier',
  'confirmed',
  'blocked_unpaid',
]);
export const studentDocumentStatusSchema = z.enum(['missing', 'provided', 'to_renew']);

export type EnrollmentStatus = z.infer<typeof enrollmentStatusSchema>;
export type EnrollmentType = z.infer<typeof enrollmentTypeSchema>;
export type StudentDocumentStatus = z.infer<typeof studentDocumentStatusSchema>;

export const uuidParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const studentParamsSchema = z.object({ studentId: z.string().uuid() }).strict();

export const enrollmentListQuerySchema = z.object({
  school_year_id: z.string().uuid().optional(),
  status: enrollmentStatusSchema.optional(),
  type: enrollmentTypeSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createEnrollmentBodySchema = z
  .object({
    studentId: z.string().uuid(),
    classId: z.string().uuid(),
    schoolYearId: z.string().uuid(),
    type: enrollmentTypeSchema,
    hasPreviousYearUnpaid: z.boolean().default(false),
  })
  .strict();

export const updateEnrollmentBodySchema = z
  .object({
    classId: z.string().uuid().optional(),
    status: z.enum(['pending_cashier', 'pending_dossier']).optional(),
  })
  .strict()
  .refine((value) => value.classId !== undefined || value.status !== undefined, {
    message: 'At least one field must be provided',
  });

export const requiredDocumentListQuerySchema = z.object({ level_id: z.string().uuid().optional() });
export const createRequiredDocumentTypeBodySchema = z
  .object({ levelId: z.string().uuid(), name: z.string().trim().min(1).max(150), isMandatory: z.boolean().default(true) })
  .strict();
export const createRequiredDocumentTypesBodySchema = z
  .object({
    levelIds: z.array(z.string().uuid()).min(1).max(50).transform((ids) => [...new Set(ids)]),
    name: z.string().trim().min(1).max(150),
    isMandatory: z.boolean().default(true),
  })
  .strict();
export const syncRequiredDocumentTypesBodySchema = createRequiredDocumentTypesBodySchema.extend({
  documentTypeIds: z.array(z.string().uuid()).min(1).max(50).transform((ids) => [...new Set(ids)]),
});
export const updateRequiredDocumentTypeBodySchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    isMandatory: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.isMandatory !== undefined || value.isActive !== undefined, {
    message: 'At least one field must be provided',
  });

export const upsertStudentDocumentBodySchema = z
  .object({
    documentTypeId: z.string().uuid(),
    status: studentDocumentStatusSchema,
    r2Key: z.string().trim().min(1).max(500).nullable().optional(),
    fileUrl: z.string().url().max(2_000).nullable().optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'provided' && !value.r2Key && !value.fileUrl) {
      context.addIssue({ code: 'custom', message: 'A provided document requires r2Key or fileUrl' });
    }
  });

export const updateStudentDocumentBodySchema = z
  .object({
    status: studentDocumentStatusSchema.optional(),
    r2Key: z.string().trim().min(1).max(500).nullable().optional(),
    fileUrl: z.string().url().max(2_000).nullable().optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one field must be provided',
  });
