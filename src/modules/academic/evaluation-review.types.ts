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
  gradingPeriods: Array<ReviewOption & { schoolYearId: string; isCurrent: boolean; isFuture: boolean; hasEvaluations: boolean }>;
  levels: ReviewOption[];
  classes: Array<ReviewOption & { levelId: string }>;
  subjects: Array<ReviewOption & { levelId: string }>;
  teachers: ReviewOption[];
};
