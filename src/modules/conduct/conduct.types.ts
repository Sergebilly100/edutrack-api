import { z } from 'zod';

export const educatorAssignmentBodySchema = z
  .object({
    class_id: z.string().uuid().optional(),
    level_id: z.string().uuid().optional(),
    user_id: z.string().uuid(),
  })
  .refine((value) => Boolean(value.class_id) !== Boolean(value.level_id), {
    message: "L'assignation se fait par classe OU par niveau",
  });

export type EducatorAssignmentBody = z.infer<typeof educatorAssignmentBodySchema>;

export const educatorAssignmentParamsSchema = z.object({
  id: z.string().uuid(),
});

export const conductInputBodySchema = z.object({
  student_id: z.string().uuid(),
  grading_period_id: z.string().uuid(),
  note: z.coerce.number().min(0).max(20),
  observation: z.string().trim().max(1000).optional(),
});

export type ConductInputBody = z.infer<typeof conductInputBodySchema>;

export const conductGradeBodySchema = z.object({
  student_id: z.string().uuid(),
  grading_period_id: z.string().uuid(),
  note: z.coerce.number().min(0).max(20),
  coefficient: z.coerce.number().positive().optional(),
});

export type ConductGradeBody = z.infer<typeof conductGradeBodySchema>;

export const conductOverviewQuerySchema = z.object({
  grading_period_id: z.string().uuid(),
});

export const conductStudentParamsSchema = z.object({
  studentId: z.string().uuid(),
});

export type EducatorAssignmentItem = {
  id: string;
  classId: string | null;
  className: string | null;
  levelId: string | null;
  levelName: string | null;
  userId: string;
  userName: string;
  assignedAt: string;
};

export type ConductInputItem = {
  id: string;
  teacherName: string;
  subjectLabel: string | null;
  note: number;
  observation: string | null;
  createdAt: string;
};

export type SpontaneousEvaluationItem = {
  id: string;
  label: string;
  score: number;
  maxScore: number;
  comment: string | null;
  createdAt: string;
};

export type ConductOverview = {
  student: {
    id: string;
    fullName: string;
    className: string;
  };
  gradingPeriod: {
    id: string;
    label: string;
  };
  teacherInputs: ConductInputItem[];
  spontaneousEvaluations: SpontaneousEvaluationItem[];
  finalGrade: {
    note: number;
    coefficient: number;
    decidedByUserId: string;
    decidedAt: string;
  } | null;
};
