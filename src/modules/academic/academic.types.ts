import { z } from 'zod';

export const schoolYearStatusSchema = z.enum(['draft', 'active', 'closed']);
export type SchoolYearStatus = z.infer<typeof schoolYearStatusSchema>;

const SCHOOL_YEAR_LABEL_REGEX = /^(0[1-9]|1[0-2])\/\d{4} - (0[1-9]|1[0-2])\/\d{4}$/;
const ISO_DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const isValidIsoDate = (value: string): boolean => {
  if (!ISO_DATE_REGEX.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const isoDateSchema = z.string().refine(isValidIsoDate, {
  message: 'Expected a valid date in YYYY-MM-DD format',
});

export type SchoolYearConsistencyInput = {
  label: string;
  startDate: string;
  endDate: string;
  endOfYearReviewStartDate?: string;
};

export const getDefaultEndOfYearReviewStartDate = (endDate: string): string => {
  const date = new Date(`${endDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 30);
  return date.toISOString().slice(0, 10);
};

export const getSchoolYearConsistencyIssue = (
  input: SchoolYearConsistencyInput
): string | null => {
  if (!SCHOOL_YEAR_LABEL_REGEX.test(input.label)) {
    return 'School year label must use MM/YYYY - MM/YYYY format';
  }

  if (!isValidIsoDate(input.startDate) || !isValidIsoDate(input.endDate)) {
    return 'School year dates must use valid YYYY-MM-DD values';
  }

  if (input.startDate >= input.endDate) {
    return 'School year start date must be before end date';
  }

  if (
    input.endOfYearReviewStartDate !== undefined &&
    (!isValidIsoDate(input.endOfYearReviewStartDate) || input.endOfYearReviewStartDate >= input.endDate)
  ) {
    return 'End-of-year review start date must be before school year end date';
  }

  const expectedLabel = `${input.startDate.slice(5, 7)}/${input.startDate.slice(0, 4)} - ${input.endDate.slice(5, 7)}/${input.endDate.slice(0, 4)}`;
  if (input.label !== expectedLabel) {
    return 'School year label must match the start and end date months';
  }

  return null;
};

const addSchoolYearConsistencyIssue = (
  input: SchoolYearConsistencyInput,
  context: z.RefinementCtx
): void => {
  const issue = getSchoolYearConsistencyIssue(input);
  if (issue) {
    context.addIssue({
      code: 'custom',
      message: issue,
      path: issue.includes('label') ? ['label'] : ['startDate'],
    });
  }
};

export const schoolYearIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const createSchoolYearBodySchema = z
  .object({
    label: z.string().trim().regex(SCHOOL_YEAR_LABEL_REGEX),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    endOfYearReviewStartDate: isoDateSchema.optional(),
    status: schoolYearStatusSchema.default('draft'),
  })
  .superRefine(addSchoolYearConsistencyIssue);

export const updateSchoolYearBodySchema = z
  .object({
    endOfYearReviewStartDate: isoDateSchema,
  })
  .strict();

export const levelIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const createLevelBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  orderIndex: z.number().int().min(0),
  isExamClass: z.boolean().default(false),
});

export const updateLevelBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    orderIndex: z.number().int().min(0).optional(),
    isExamClass: z.boolean().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one field is required',
  });

export const classIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const listClassesQuerySchema = z.object({
  schoolYearId: z.string().uuid().optional(),
});

export const createClassBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  levelId: z.string().uuid(),
  homeroomTeacherId: z.string().uuid().nullable().optional(),
});

export const updateClassBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    levelId: z.string().uuid().optional(),
    homeroomTeacherId: z.string().uuid().nullable().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one field is required',
  });

export type CreateSchoolYearInput = z.infer<typeof createSchoolYearBodySchema>;
export type UpdateSchoolYearInput = z.infer<typeof updateSchoolYearBodySchema>;
export type CreateLevelInput = z.infer<typeof createLevelBodySchema>;
export type UpdateLevelInput = z.infer<typeof updateLevelBodySchema>;
export type CreateClassInput = z.infer<typeof createClassBodySchema>;
export type UpdateClassInput = z.infer<typeof updateClassBodySchema>;

export type SchoolYearRow = {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  end_of_year_review_start_date: string;
  status: SchoolYearStatus;
  created_at: Date | string;
  updated_at: Date | string;
};

export type SchoolYearItem = {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  endOfYearReviewStartDate: string;
  status: SchoolYearStatus;
  createdAt: string;
  updatedAt: string;
};

export type LevelRow = {
  id: string;
  name: string;
  order_index: number;
  is_exam_class: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

export type LevelItem = {
  id: string;
  name: string;
  orderIndex: number;
  isExamClass: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ClassRow = {
  id: string;
  name: string;
  student_count: number;
  is_active: boolean;
  level_id: string;
  level_name: string;
  level_order_index: number;
  school_year_id: string;
  school_year_label: string;
  homeroom_teacher_id: string | null;
  homeroom_teacher_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type ClassItem = {
  id: string;
  name: string;
  studentCount: number;
  isActive: boolean;
  level: {
    id: string;
    name: string;
    orderIndex: number;
  };
  schoolYear: {
    id: string;
    label: string;
  };
  homeroomTeacher: {
    id: string;
    name: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};
