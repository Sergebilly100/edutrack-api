import { z } from 'zod';

export const classDecisionSchema = z.enum(['promoted', 'repeat', 'expelled']);
export type ClassDecisionValue = z.infer<typeof classDecisionSchema>;

export const classDecisionStudentParamsSchema = z.object({
  studentId: z.string().uuid(),
});

export const validateClassDecisionBodySchema = z
  .object({
    finalDecision: classDecisionSchema,
    nextLevelId: z.string().uuid().nullable().default(null),
  })
  .strict();

export type ValidateClassDecisionInput = z.infer<typeof validateClassDecisionBodySchema>;

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
  currentLevelName: string;
  suggestedDecision: ClassDecisionValue | null;
  finalDecision: ClassDecisionValue | null;
  nextLevelId: string | null;
  nextLevelName: string | null;
  validatedAt: string | null;
};

export type LevelOption = { id: string; name: string; orderIndex: number };
