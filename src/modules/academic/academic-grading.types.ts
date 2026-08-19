import { z } from 'zod';

const isoDateSchema = z.string().date();
const positiveDecimalSchema = z.number().finite().positive();

export const academicIdParamsSchema = z.object({ id: z.string().uuid() });

export const listSubjectsQuerySchema = z.object({
  levelId: z.string().uuid().optional(),
});

export const createSubjectBodySchema = z.object({
  levelId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  coefficient: positiveDecimalSchema,
});

export const updateSubjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    coefficient: positiveDecimalSchema.optional(),
  })
  .refine((input) => input.name !== undefined || input.coefficient !== undefined, {
    message: 'At least one field is required',
  });

export const listGradingPeriodsQuerySchema = z.object({
  schoolYearId: z.string().uuid().optional(),
});

export const createGradingPeriodBodySchema = z
  .object({
    schoolYearId: z.string().uuid(),
    type: z.enum(['trimester', 'semester']),
    orderIndex: z.number().int().positive(),
    label: z.string().trim().min(1).max(100),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
  })
  .refine((input) => input.startDate <= input.endDate, {
    message: 'Period start date must be before or equal to end date',
    path: ['startDate'],
  });

export const updateGradingPeriodBodySchema = z
  .object({
    orderIndex: z.number().int().positive().optional(),
    label: z.string().trim().min(1).max(100).optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one field is required',
  })
  .refine(
    (input) => !input.startDate || !input.endDate || input.startDate <= input.endDate,
    { message: 'Period start date must be before or equal to end date', path: ['startDate'] }
  );

export const createEvaluationBodySchema = z.object({
  lessonSlotId: z.string().uuid(),
  subjectId: z.string().uuid(),
  classId: z.string().uuid(),
  gradingPeriodId: z.string().uuid(),
  type: z.enum(['scheduled', 'spontaneous']),
  coefficient: positiveDecimalSchema,
  label: z.string().trim().min(1).max(150),
});

export const upsertEvaluationGradeBodySchema = z
  .object({
    studentId: z.string().uuid(),
    score: z.number().finite().nonnegative(),
    maxScore: positiveDecimalSchema,
    comment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((input) => input.score <= input.maxScore, {
    message: 'Score must be less than or equal to max score',
    path: ['score'],
  });

export const completionBodySchema = z.object({
  classId: z.string().uuid(),
  subjectId: z.string().uuid(),
  gradingPeriodId: z.string().uuid(),
  status: z.enum(['in_progress', 'completed']),
});

export const completionQuerySchema = z.object({
  classId: z.string().uuid(),
  gradingPeriodId: z.string().uuid(),
});

export type CreateSubjectInput = z.infer<typeof createSubjectBodySchema>;
export type UpdateSubjectInput = z.infer<typeof updateSubjectBodySchema>;
export type CreateGradingPeriodInput = z.infer<typeof createGradingPeriodBodySchema>;
export type UpdateGradingPeriodInput = z.infer<typeof updateGradingPeriodBodySchema>;
export type CreateEvaluationInput = z.infer<typeof createEvaluationBodySchema>;
export type UpsertEvaluationGradeInput = z.infer<typeof upsertEvaluationGradeBodySchema>;
export type CompletionInput = z.infer<typeof completionBodySchema>;

export type SubjectItem = {
  id: string;
  levelId: string;
  levelName: string;
  name: string;
  coefficient: number;
};

export type GradingPeriodItem = {
  id: string;
  schoolYearId: string;
  type: 'trimester' | 'semester';
  orderIndex: number;
  label: string;
  startDate: string;
  endDate: string;
};
