import { z } from 'zod';

export const IMPORT_PHONE_REGEX = /^225\d{10}$/;

export const importTypeSchema = z.enum(['students', 'teachers', 'schedule']);

export type ImportType = z.infer<typeof importTypeSchema>;

export const importTypeParamsSchema = z.object({
  type: importTypeSchema,
});

export type ImportError = {
  row: number;
  column: string;
  message: string;
  value: string;
};

export type DryRunReport = {
  valid: number;
  errors: ImportError[];
  preview: Record<string, string>[];
};

export type ConfirmReport = {
  imported: number;
  updated: number;
  errors: ImportError[];
  preview: Record<string, string>[];
};

export type StudentImportRow = {
  firstName: string;
  lastName: string;
  className: string;
  parentPhone: string | null;
};

export type TeacherImportRow = {
  lastName: string;
  firstName: string;
  type: 'vacataire' | 'permanent';
  subjects: string[];
  hourlyRate: number | null;
  username: string;
};

export type ScheduleImportRow = {
  teacherName: string;
  className: string;
  subject: string;
  dayOfWeek: number;
  slotLabel: string;
  roomName: string;
};
