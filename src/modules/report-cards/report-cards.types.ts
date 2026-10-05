import { z } from 'zod';

export const generateReportCardBodySchema = z.object({
  class_id: z.string().uuid(),
  grading_period_id: z.string().uuid(),
});

export type GenerateReportCardBody = z.infer<typeof generateReportCardBodySchema>;

export const reportCardIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const readinessQuerySchema = z.object({
  grading_period_id: z.string().uuid(),
});

export const reportCardClassesQuerySchema = z.object({
  schoolYearId: z.string().uuid(),
});

export const parentReportCardsQuerySchema = z.object({
  schoolYearId: z.string().uuid().optional(),
});

export const publishBulkBodySchema = z.object({
  class_id: z.string().uuid().optional(),
  grading_period_id: z.string().uuid(),
});

export const createReportCardClaimBodySchema = z.object({
  classId: z.string().uuid(),
  studentId: z.string().uuid().optional(),
  subjectId: z.string().uuid(),
  gradingPeriodId: z.string().uuid(),
  reason: z.string().trim().min(10).max(4000),
});

export const decideReportCardClaimBodySchema = z.object({
  decision: z.enum(['approved', 'refused']),
  reason: z.string().trim().min(10).max(4000),
});

export const reportCardClaimQuerySchema = z.object({
  schoolYearId: z.string().uuid().optional(),
  gradingPeriodId: z.string().uuid().optional(),
  classId: z.string().uuid().optional(),
  studentId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  status: z.enum(['open', 'pending_exceptional_authorization', 'approved', 'refused', 'corrected', 'regenerated', 'republished']).optional(),
});

export const claimIdParamsSchema = z.object({ id: z.string().uuid() });

export type PublishBulkBody = z.infer<typeof publishBulkBodySchema>;

export type ReportCardLineItem = {
  id: string;
  subjectId: string | null;
  subjectName: string | null;
  lineType: 'subject' | 'conduct';
  average: number;
  coefficient: number;
  rank: number | null;
};

export type ReportCardDetail = {
  id: string;
  studentId: string;
  studentName: string;
  classId: string;
  className: string;
  gradingPeriodId: string;
  periodLabel: string;
  schoolYearLabel: string;
  generalAverage: number;
  rank: number;
  classAverage: number;
  classMinAverage: number;
  classMaxAverage: number;
  classHeadcount: number;
  yearEndDecision: {
    decision: 'promoted' | 'repeat' | 'expelled';
  } | null;
  status: 'generated' | 'published';
  generatedAt: string;
  publishedAt: string | null;
  lines: ReportCardLineItem[];
};

export type ReportCardSummaryItem = {
  id: string;
  studentId: string;
  studentName: string;
  generalAverage: number;
  rank: number;
  status: 'generated' | 'published';
};

export type ClassReadiness = {
  classId: string;
  className: string;
  headcount: number;
  studentsWithGeneralAverage: number;
  studentsWithFinalConduct: number;
  subjects: Array<{
    subjectId: string;
    subjectName: string;
    completedCount: number;
    expectedCount: number;
    complete: boolean;
  }>;
  readyToGenerate: boolean;
};
