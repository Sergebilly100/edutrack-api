import { z } from 'zod';

export const classDecisionSchema = z.enum(['promoted', 'repeat', 'expelled']);
export type ClassDecisionValue = z.infer<typeof classDecisionSchema>;

export const classDecisionStudentParamsSchema = z.object({
  studentId: z.string().uuid(),
});

export const listClassDecisionsQuerySchema = z.object({
  level_id: z.string().uuid().optional(),
  class_id: z.string().uuid().optional(),
});

export const validateClassDecisionBodySchema = z
  .object({
    finalDecision: classDecisionSchema,
    nextLevelId: z.string().uuid().nullable().default(null),
  })
  .strict();

export type ValidateClassDecisionInput = z.infer<typeof validateClassDecisionBodySchema>;

const bulkDecisionRuleSchema = z
  .object({
    finalDecision: classDecisionSchema,
    nextLevelId: z.string().uuid().nullable(),
  })
  .strict();

export const bulkClassDecisionsBodySchema = z
  .object({
    levelId: z.string().uuid().optional(),
    classId: z.string().uuid().optional(),
    threshold: z.number().min(0).max(20),
    atOrAbove: bulkDecisionRuleSchema,
    below: bulkDecisionRuleSchema,
  })
  .strict()
  .refine((value) => value.levelId || value.classId, {
    message: 'A level or class scope is required',
    path: ['levelId'],
  });

export type BulkClassDecisionsInput = z.infer<typeof bulkClassDecisionsBodySchema>;

export type EndOfYearSchoolYear = {
  id: string;
  label: string;
  endDate: string;
  endOfYearReviewStartDate: string;
};

export type ClassDecisionItem = {
  studentId: string;
  studentFirstName: string;
  studentLastName: string;
  studentMatricule: string | null;
  className: string;
  currentLevelId: string;
  currentLevelName: string;
  generalAverage: number | null;
  suggestedDecision: ClassDecisionValue | null;
  finalDecision: ClassDecisionValue | null;
  nextLevelId: string | null;
  nextLevelName: string | null;
  validatedAt: string | null;
};

export type BulkClassDecisionPreviewItem = ClassDecisionItem & {
  proposedDecision: ClassDecisionValue | null;
  proposedNextLevelId: string | null;
  proposedNextLevelName: string | null;
  isEligible: boolean;
  blockingReason: 'GENERAL_AVERAGE_PENDING' | null;
};

export type BulkClassDecisionsPreview = {
  items: BulkClassDecisionPreviewItem[];
  eligibleCount: number;
  pendingCount: number;
  canApply: boolean;
};

export type LevelOption = { id: string; name: string; orderIndex: number };
export type ClassOption = { id: string; name: string; levelId: string };
