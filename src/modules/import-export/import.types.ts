import { z } from 'zod';

export const IMPORT_PHONE_REGEX = /^225\d{10}$/;

export const importTypeSchema = z.enum(['students', 'teachers', 'schedule']);
export const importModeSchema = z.enum(['merge', 'replace']).default('merge');

export type ImportType = z.infer<typeof importTypeSchema>;
export type ImportMode = z.infer<typeof importModeSchema>;

export const importTypeParamsSchema = z.object({
  type: importTypeSchema,
});

export type ImportError = {
  row: number;
  column: string;
  message: string;
  value: string;
  severity?: 'error' | 'warning';
  sheet?: string;
};

export type DiffPreviewItem = {
  key: string;
  displayName: string;
  changes?: Record<string, { before: string | null; after: string | null }>;
};

export type DryRunReport = {
  valid: number;
  errors: ImportError[];
  preview: Record<string, string>[];
  toAdd?: DiffPreviewItem[];
  toUpdate?: DiffPreviewItem[];
  toDelete?: DiffPreviewItem[];
  unchanged?: number;
  importMode?: ImportMode;
  conflicts?: Array<{
    periodName: string;
    weekStart: string;
    weekEnd: string;
    message: string;
  }>;
};

export type ConfirmReport = {
  imported: number;
  updated: number;
  errors: ImportError[];
  preview: Record<string, string>[];
  deactivated?: number;
  importMode?: ImportMode;
};

export type StudentImportRow = {
  matricule: string | null;
  firstName: string;
  lastName: string;
  className: string;
  birthDate: string | null;
  parentName: string | null;
  parentPhone: string | null;
  parentEmail: string | null;
  parentName2: string | null;
  parentPhone2: string | null;
};

export type TeacherImportRow = {
  matricule: string | null;
  lastName: string;
  firstName: string;
  type: 'vacataire' | 'permanent';
  subjects: string[];
  hourlyRate: number | null;
  monthlySalary: number | null;
  username: string;
};

export type ScheduleImportRow = {
  teacherName: string;
  className: string;
  subject: string;
  dayOfWeek: number;
  slotLabel: string;
  roomName: string;
  roomBuilding: string | null;
  roomCapacity: number | null;
  startDate: string | null;
};

export type SchedulePeriodInput = {
  weekStart: string;
  weekEnd: string;
};
