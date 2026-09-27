import type { TenantDb } from '../database/db.js';
import type { MappingFieldDefinition } from './engine.js';
import type { MappingProfile } from './mapping.repository.js';

export class MidyearImportError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) {
    super(message);
    this.name = 'MidyearImportError';
  }
}

export type RecoveryImpact = {
  profilesCreated: number; profilesReused: number;
  classesCreated: number; classesReused: number;
  enrollmentsCreated: number; enrollmentsReused: number;
  paymentsCreated: number; paymentsReused: number;
  assignmentsCreated?: number;
};
export type RecoveryRow = {
  rowNumber: number;
  values: Record<string, string>;
  studentId?: string;
  classId?: string;
  levelId?: string;
  enrollmentId?: string;
  reused?: boolean;
  teachingAssignments?: Array<{ teacherId: string; subjectId: string; classId: string }>;
};
export type RecoveryPreview = {
  schoolYearId: string;
  validRows: RecoveryRow[];
  errors: Array<{ rowNumber: number; reason: string; column?: string; value?: string }>;
  totalRows: number;
  impact: RecoveryImpact;
  classesWithoutTeacherAssignments: number;
  classesWithoutHomeroomTeacher?: Array<{ id: string; name: string }>;
  previewToken: string;
};
export type RecoveryResult = {
  createdCount: number; reusedCount: number;
  errors: RecoveryPreview['errors']; totalRows: number; impact: RecoveryImpact;
  classesWithoutHomeroomTeacher?: Array<{ id: string; name: string }>;
};

/** Supplied by the composition root, so admin never imports the finance module. */
export type MidyearImportPort = {
  getProfile(importType: string): Promise<MappingProfile | null>;
  saveProfile(input: { importType: string; label?: string; actorUserId: string; fields: MappingFieldDefinition[] }): Promise<MappingProfile>;
  analyze(importType: string, file: Buffer, yearId: string): Promise<unknown>;
  preview(importType: string, file: Buffer, yearId: string): Promise<RecoveryPreview>;
  confirm(importType: string, file: Buffer, yearId: string, token: string, actorUserId: string): Promise<RecoveryResult>;
};
export type MidyearImportFactory = (db: TenantDb) => MidyearImportPort;
