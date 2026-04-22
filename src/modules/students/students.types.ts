import { z } from 'zod';

export const PHONE_CI_REGEX = /^225\d{10}$/;
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const studentsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  class_id: z.uuid().optional(),
  is_active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return undefined;
      }

      return value === 'true';
    }),
  search: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional(),
});

const parentPhoneSchema = z
  .string()
  .regex(PHONE_CI_REGEX, 'parent_phone must match 225 followed by 10 digits')
  .nullable();

const parentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .nullable();

const parentPhone2Schema = z
  .string()
  .regex(PHONE_CI_REGEX, 'parent_phone_2 must match 225 followed by 10 digits')
  .nullable();

export const createStudentBodySchema = z.object({
  class_id: z.uuid(),
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  parent_name: parentNameSchema.optional().default(null),
  parent_phone: parentPhoneSchema.default(null),
  parent_name_2: parentNameSchema.optional().default(null),
  parent_phone_2: parentPhone2Schema.optional().default(null),
  notes: z.string().trim().max(5000).nullable().optional().default(null),
  is_active: z.boolean().optional().default(true),
});

export const updateStudentParamsSchema = z.object({
  id: z.uuid(),
});

export const updateStudentBodySchema = z
  .object({
    class_id: z.uuid().optional(),
    first_name: z.string().trim().min(1).max(100).optional(),
    last_name: z.string().trim().min(1).max(100).optional(),
    parent_name: parentNameSchema.optional(),
    parent_phone: parentPhoneSchema.optional(),
    parent_name_2: parentNameSchema.optional(),
    parent_phone_2: parentPhone2Schema.optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field is required',
  });

export const bulkAttendanceBodySchema = z.object({
  scheduleId: z.uuid(),
  date: z.string().regex(ISO_DATE_REGEX, 'date must use YYYY-MM-DD format'),
  absences: z.array(z.uuid()).default([]),
});

export const attendanceHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  class_id: z.uuid().optional(),
  student_id: z.uuid().optional(),
  schedule_id: z.uuid().optional(),
  date_from: z.string().regex(ISO_DATE_REGEX).optional(),
  date_to: z.string().regex(ISO_DATE_REGEX).optional(),
});

export const absenceStatsQuerySchema = z.object({
  from: z.string().regex(ISO_DATE_REGEX),
  to: z.string().regex(ISO_DATE_REGEX),
  class_id: z.string().uuid().optional(),
  subject: z.string().trim().min(1).optional(),
  sms_status: z.enum(['sent', 'not_sent', 'failed']).optional(),
  min_absences: z.coerce.number().int().min(1).default(1),
});

export const studentAbsencesParamsSchema = z.object({
  studentId: z.string().uuid(),
});

export const studentAbsencesQuerySchema = z.object({
  from: z.string().regex(ISO_DATE_REGEX),
  to: z.string().regex(ISO_DATE_REGEX),
  subject: z.string().trim().min(1).optional(),
});

export type UserRole = 'director' | 'staff' | 'secretary' | 'teacher' | 'super_admin';

export type AccessContext = {
  userId: string;
  schemaName: string;
  role: UserRole;
};

export type PaginationQuery = {
  page: number;
  limit: number;
};

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type StudentRecord = {
  id: string;
  classId: string;
  className: string;
  firstName: string;
  lastName: string;
  parentName?: string | null;
  parentPhone: string | null;
  parentName2?: string | null;
  parentPhone2: string | null;
  note?: string | null;
  isActive: boolean;
  createdAt: string;
};

export type StudentRecentAbsence = {
  date: string;
  subject: string;
  teacherName: string;
  startTime: string | null;
  endTime: string | null;
  roomName: string | null;
  smsStatus: 'sent' | 'failed' | 'not_sent' | null;
};

export type StudentDocumentRecord = {
  id: string;
  fileName: string;
  fileUrl: string;
  uploadedAt: string;
};

export type StudentParentSmsRecord = {
  id: string;
  date: string;
  reason: string;
  recipientPhone: string;
  status: 'queued' | 'sent' | 'failed' | 'delivered';
};

export type StudentDetailRecord = {
  id: string;
  firstName: string;
  lastName: string;
  className: string;
  classId: string;
  isActive: boolean;
  parentPhone: string | null;
  parentPhone2: string | null;
  parentName: string | null;
  parentName2: string | null;
  note: string | null;
  createdAt: string;
  absenceSummary: {
    total: number;
    thisMonth: number;
    thisWeek: number;
  };
  recentAbsences: StudentRecentAbsence[];
  documents: StudentDocumentRecord[];
  parentSms: StudentParentSmsRecord[];
};

export type AttendanceStudentRecord = {
  id: string;
  date: string;
  scheduleId: string | null;
  studentId: string;
  studentFirstName: string;
  studentLastName: string;
  classId: string;
  className: string;
  status: 'present' | 'absent' | 'excused';
  markedBy: string | null;
  smsStatus: 'queued' | 'sent' | 'failed' | 'delivered' | null;
  smsNotified: boolean;
  createdAt: string;
};

export type TodayAbsenceRow = {
  classId: string;
  className: string;
  studentId: string;
  studentFirstName: string;
  studentLastName: string;
  scheduleId: string | null;
  date: string;
  createdAt: string;
  smsStatus: 'queued' | 'sent' | 'failed' | 'delivered' | null;
  smsNotified: boolean;
};

export type TodayAbsenceGroup = {
  classId: string;
  className: string;
  absences: Array<{
    studentId: string;
    studentFirstName: string;
    studentLastName: string;
    scheduleId: string | null;
    date: string;
    createdAt: string;
    smsStatus: 'queued' | 'sent' | 'failed' | 'delivered' | null;
    smsNotified: boolean;
  }>;
};

export type AbsenceStatsQuery = z.infer<typeof absenceStatsQuerySchema>;
export type StudentAbsencesQuery = z.infer<typeof studentAbsencesQuerySchema>;

export type StudentAbsenceStatRecord = {
  student_id: string;
  student_name: string;
  class_name: string;
  class_id: string;
  parent_phone: string | null;
  parent_phone_2: string | null;
  absence_count: number;
  total_scheduled: number;
  absence_rate: number;
  sms_summary: 'all_sent' | 'partial' | 'none';
};

export type StudentAbsenceDetailRecord = {
  date: string;
  subject: string;
  class_name: string;
  start_time: string;
  end_time: string;
  sms_phone_1: {
    phone: string | null;
    status: 'sent' | 'failed' | 'not_sent';
    sent_at: string | null;
  };
  sms_phone_2: {
    phone: string | null;
    status: 'sent' | 'failed' | 'not_sent';
    sent_at: string | null;
  };
};

export type BulkAttendanceInput = z.infer<typeof bulkAttendanceBodySchema>;
export type StudentsListQuery = z.infer<typeof studentsListQuerySchema>;
export type CreateStudentInput = z.infer<typeof createStudentBodySchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentBodySchema>;
export type AttendanceHistoryQuery = z.infer<typeof attendanceHistoryQuerySchema>;
