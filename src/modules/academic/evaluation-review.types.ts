import { z } from 'zod';

export const evaluationReviewQuerySchema = z.object({
  schoolYearId: z.string().uuid(),
  gradingPeriodId: z.string().uuid(),
  levelId: z.string().uuid().optional(),
  classId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  teacherId: z.string().uuid().optional(),
  studentSearch: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  sort: z.enum(['delay', 'teacher', 'class']).default('delay'),
});

export const evaluationReminderParamsSchema = z.object({ id: z.string().uuid() });
export const evaluationReminderBodySchema = z.object({ force: z.boolean().optional() }).default({});

export const evaluationBatchReminderSchema = z.object({
  evaluationIds: z.array(z.string().uuid()).min(1).max(50).transform((ids) => [...new Set(ids)]),
  force: z.boolean().optional(),
});

export const evaluationReviewOptionsSchema = z.object({
  schoolYearId: z.string().uuid().optional(),
  gradingPeriodId: z.string().uuid().optional(),
  levelId: z.string().uuid().optional(),
  classId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
});

export type EvaluationReviewQuery = z.infer<typeof evaluationReviewQuerySchema>;
export type EvaluationReviewOptionsQuery = z.infer<typeof evaluationReviewOptionsSchema>;

export type ReviewOption = { id: string; label: string };
export type EvaluationReviewOptions = {
  schoolYears: Array<ReviewOption & { active: boolean }>;
  gradingPeriods: Array<ReviewOption & { schoolYearId: string; isCurrent: boolean; notesEntryOpen: boolean; isFuture: boolean; hasEvaluations: boolean }>;
  levels: ReviewOption[];
  classes: Array<ReviewOption & { levelId: string }>;
  subjects: Array<ReviewOption & { levelId: string }>;
  teachers: ReviewOption[];
};
