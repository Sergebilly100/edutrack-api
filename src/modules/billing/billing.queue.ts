import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import archiver from 'archiver';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { logger as appLogger } from '../../shared/observability/logger.js';
import {
  fetchSchoolBranding,
  renderPaymentHistory,
  renderRevenueReport,
  renderSchoolSalaryBilan,
  renderStudentAbsencesReport,
  renderTeacherAttendanceReport,
  renderTeacherHoursReport,
  renderTeacherMultiPeriodBilan,
  renderTeacherSalaryBilan,
  type DocumentBranding,
  type TeacherSalaryDetails,
} from '../../shared/pdf/index.js';
import { withTenantSchema } from '../../shared/database/db.js';
import { isR2Configured, uploadBuffer } from '../../shared/storage/r2.js';
import { buildAttendanceService } from '../attendance/attendance.service.js';
import { buildStudentsService } from '../students/students.service.js';
import { SubscriptionsRepository } from '../subscriptions/subscriptions.repository.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { buildTeachersService } from '../teachers/teachers.service.js';

import { buildBillingService } from './billing.service.js';

export const BILLING_PDF_QUEUE_NAME = 'pdf-exports';

// Configurable via variable d'environnement (fallback: /tmp pour dev local)
// En production Railway, utiliser un volume persistant ou un stockage cloud (R2/S3)
export const BILLING_EXPORT_DIR = process.env.BILLING_EXPORT_DIR ?? '/tmp/edutrack-exports';

const toSafeFilePart = (value: string): string => value.replace(/[^a-zA-Z0-9_-]+/g, '_');

const toMonthDateUtc = (month: string): Date => {
  const [yearRaw, monthRaw] = month.split('-');
  const year = Number(yearRaw);
  const monthValue = Number(monthRaw);

  if (!Number.isInteger(year) || !Number.isInteger(monthValue) || monthValue < 1 || monthValue > 12) {
    throw new Error(`Invalid month value: ${month}`);
  }

  return new Date(Date.UTC(year, monthValue - 1, 1));
};

const iterateMonths = (periodFrom: string, periodTo: string): string[] => {
  const start = toMonthDateUtc(periodFrom);
  const end = toMonthDateUtc(periodTo);
  const months: string[] = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
};

type TeacherExportPayload = Awaited<ReturnType<ReturnType<typeof buildBillingService>['getExportTeacherPayload']>>;

/**
 * Adapte le payload du service billing à la forme attendue par le template PDF.
 * Garde le module billing et le toolkit PDF découplés (pas d'import croisé de types).
 */
const toTeacherDetails = (payload: TeacherExportPayload): TeacherSalaryDetails => ({
  month: payload.month,
  teacher: {
    id: payload.teacher.id,
    name: payload.teacher.name,
    type: payload.teacher.type,
    hourlyRate: payload.teacher.hourlyRate,
    monthlySalary: payload.teacher.monthlySalary,
  },
  summary: {
    hoursPlanned: payload.summary.hoursPlanned,
    hoursDone: payload.summary.hoursDone,
    totalFcfa: payload.summary.totalFcfa,
    status: payload.summary.status,
    absenceHours: payload.summary.absenceHours,
    amountAlreadyPaid: payload.summary.amountAlreadyPaid,
    amountRemainingToPayNow: payload.summary.amountRemainingToPayNow,
  },
  payment: {
    paidAt: payload.payment.paidAt,
    paidByName: payload.payment.paidByName,
    notes: payload.payment.notes,
  },
  rows: payload.rows.map((row) => ({
    date: row.date,
    slotLabel: row.slotLabel,
    subject: row.subject,
    className: row.className,
    attendanceStatus: row.attendanceStatus,
    lateMinutes: row.lateMinutes,
    hoursDone: row.hoursDone,
  })),
});

type ExportArtifact = {
  filePath: string;
  fileName: string;
  generatedAt: string;
  r2Key?: string;
};

// R2 objects live under this prefix and survive instance restarts. Keep a flat layout -
// jobId in the filename is unique enough to avoid collisions across tenants.
const buildR2Key = (fileName: string): string => `billing/exports/${fileName}`;

const persistPdf = async (bytes: Uint8Array, fileName: string): Promise<ExportArtifact> => {
  const generatedAt = new Date().toISOString();

  if (isR2Configured()) {
    const r2Key = buildR2Key(fileName);
    await uploadBuffer(r2Key, Buffer.from(bytes), 'application/pdf');
    // filePath kept empty-ish for the legacy return type; the download endpoint
    // checks r2Key first and only falls back to filePath when R2 is off.
    return { filePath: '', fileName, generatedAt, r2Key };
  }

  await mkdir(BILLING_EXPORT_DIR, { recursive: true });
  const filePath = path.join(BILLING_EXPORT_DIR, fileName);
  await writeFile(filePath, bytes);
  return { filePath, fileName, generatedAt };
};

const writeZipArchive = async (params: {
  fileName: string;
  entries: Array<{ fileName: string; bytes: Uint8Array }>;
}): Promise<ExportArtifact> => {
  const generatedAt = new Date().toISOString();

  if (isR2Configured()) {
    // Build the archive in-memory then upload - avoids needing disk space at all.
    const archiveBuffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (error: Error) => reject(error));

      for (const entry of params.entries) {
        archive.append(Buffer.from(entry.bytes), { name: entry.fileName });
      }
      void archive.finalize();
    });

    const r2Key = buildR2Key(params.fileName);
    await uploadBuffer(r2Key, archiveBuffer, 'application/zip');
    return { filePath: '', fileName: params.fileName, generatedAt, r2Key };
  }

  await mkdir(BILLING_EXPORT_DIR, { recursive: true });
  const filePath = path.join(BILLING_EXPORT_DIR, params.fileName);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    output.on('error', (error: Error) => reject(error));
    archive.on('error', (error: Error) => reject(error));
    archive.pipe(output);

    for (const entry of params.entries) {
      archive.append(Buffer.from(entry.bytes), { name: entry.fileName });
    }

    void archive.finalize();
  });

  return { filePath, fileName: params.fileName, generatedAt };
};

export type BillingPdfJobData =
  | {
      type: 'salary-export-teacher';
      schemaName: string;
      month: string;
      teacherId: string;
    }
  | {
      type: 'salary-export-school';
      schemaName: string;
      month: string;
    }
  | {
      type: 'salary-export-bulk';
      schemaName: string;
      periodFrom: string;
      periodTo: string;
      teacherId: string | null;
    }
  | {
      type: 'salary-export-payment-history';
      schemaName: string;
      teacherId: string;
      periodFrom: string;
      periodTo: string;
    }
  | {
      type: 'attendance-hours-export';
      schemaName: string;
      teacherId: string;
      teacherName: string;
      from: string;
      to: string;
    }
  | {
      type: 'student-absences-export';
      schemaName: string;
      studentLabel: string;
      classId: string | undefined;
      subject: string | undefined;
      from: string;
      to: string;
      minAbsences: number;
      smsStatus: 'sent' | 'not_sent' | 'failed' | undefined;
    }
  | {
      type: 'teacher-attendance-export';
      schemaName: string;
      from: string;
      to: string;
      statusFilter: 'absent' | 'room_mismatch' | 'rollcall_missing' | 'late' | undefined;
      teacherId: string | undefined;
      subject: string | undefined;
      classId: string | undefined;
    }
  | {
      type: 'revenue-export';
      schemaName: string;
      periodFrom: string;
      periodTo: string;
    };

export type BillingPdfJobResult = {
  filePath: string;
  fileName: string;
  generatedAt: string;
  fileType: 'pdf' | 'zip';
  /** Present when R2 is configured. When set, the download endpoint
   *  redirects to a presigned URL instead of streaming from disk. */
  r2Key?: string;
};

export const processBillingPdfJob = async (
  job: Job<BillingPdfJobData>
): Promise<BillingPdfJobResult> => {
  // Logger contextualisé pour le job courant
  const logger = {
    warn: (msg: string, meta?: Record<string, unknown>) => {
      appLogger.warn({ jobId: job.id, ...(meta ?? {}) }, msg);
    },
  };

  const branding: DocumentBranding = await fetchSchoolBranding(job.data.schemaName, logger);

  return withTenantSchema(job.data.schemaName, async (tenantDb) => {
    const service = buildBillingService(tenantDb);

    if (job.data.type === 'salary-export-teacher') {
      const payload = await service.getExportTeacherPayload(job.data.teacherId, job.data.month);
      const fileName = `bilan_salaire_${toSafeFilePart(payload.teacher.name)}_${toSafeFilePart(job.data.month)}.pdf`;
      const bytes = await renderTeacherSalaryBilan(branding, toTeacherDetails(payload));
      const result = await persistPdf(bytes, fileName);
      return { ...result, fileType: 'pdf' };
    }

    if (job.data.type === 'salary-export-school') {
      const summary = await service.getExportSchoolPayload(job.data.month);
      const fileName = `bilan_salaires_ecole_${toSafeFilePart(job.data.month)}.pdf`;
      const bytes = await renderSchoolSalaryBilan(branding, summary);
      const result = await persistPdf(bytes, fileName);
      return { ...result, fileType: 'pdf' };
    }

    if (job.data.type === 'salary-export-payment-history') {
      const { teacherId, periodFrom, periodTo } = job.data;
      const history = await service.getTeacherPaymentHistory(teacherId, 2000, 0);
      const items = history.items.filter(
        (item) => item.month >= periodFrom && item.month <= periodTo
      );
      const coverageSafe = `${toSafeFilePart(periodFrom)}_${toSafeFilePart(periodTo)}`;
      const fileName = `historique_paiements_${toSafeFilePart(history.teacher.name)}_${coverageSafe}.pdf`;
      const bytes = await renderPaymentHistory(branding, {
        teacher: { name: history.teacher.name, type: history.teacher.type },
        periodFrom,
        periodTo,
        items: items.map((item) => ({
          month: item.month,
          amountFcfa: item.amountFcfa,
          hoursPaid: item.hoursPaid,
          status: item.status,
          paidAt: item.paidAt,
          paidByName: item.paidByName,
          notes: item.notes,
        })),
      });
      const result = await persistPdf(bytes, fileName);
      return { ...result, fileType: 'pdf' };
    }

    if (job.data.type === 'attendance-hours-export') {
      const { teacherId, teacherName, from, to } = job.data;
      const rows = await buildAttendanceService(tenantDb).exportTeacherHistory({
        teacherId,
        from,
        to,
      });
      const resolvedName = rows[0]?.teacher_name ?? teacherName;
      const fileName = `bilan_heures_${toSafeFilePart(resolvedName)}_${toSafeFilePart(from)}_${toSafeFilePart(to)}.pdf`;
      const bytes = await renderTeacherHoursReport(branding, {
        teacher: { name: resolvedName },
        periodFrom: from,
        periodTo: to,
        rows: rows.map((row) => ({
          date: row.date,
          subject: row.subject,
          className: row.class_name,
          roomName: row.room_name,
          startTime: row.start_time,
          endTime: row.end_time,
          attendanceStatus: row.attendance_status,
          lateMinutes: row.late_minutes,
          rollcallDone: row.student_rollcall_done,
          studentPresentCount: row.student_present_count,
          studentAbsentCount: row.student_absent_count,
          studentTotalCount: row.student_total_count,
        })),
      });
      const result = await persistPdf(bytes, fileName);
      return { ...result, fileType: 'pdf' };
    }

    if (job.data.type === 'student-absences-export') {
      const { studentLabel, classId, subject, from, to, minAbsences, smsStatus } = job.data;
      const rows = await buildStudentsService(tenantDb).getAbsenceStats({
        from,
        to,
        min_absences: minAbsences,
        ...(classId !== undefined ? { class_id: classId } : {}),
        ...(subject !== undefined ? { subject } : {}),
        ...(smsStatus !== undefined ? { sms_status: smsStatus } : {}),
      });
      const fileName = `bilan_absences_eleves_${toSafeFilePart(from)}_${toSafeFilePart(to)}.pdf`;
      const bytes = await renderStudentAbsencesReport(branding, {
        studentLabel,
        from,
        to,
        rows: rows.map((row) => ({
          studentName: row.studentName,
          className: row.className,
          absenceCount: row.absenceCount,
          absenceRate: row.absenceRate,
          parentPhone: row.parentPhone,
          parentPhone2: row.parentPhone2,
          smsSummary: row.smsSummary,
        })),
      });
      const result = await persistPdf(bytes, fileName);
      return { ...result, fileType: 'pdf' };
    }

    if (job.data.type === 'teacher-attendance-export') {
      const { from, to, statusFilter, teacherId, subject, classId } = job.data;
      const rows = await buildTeachersService(tenantDb).getAttendanceStats({
        from,
        to,
        ...(subject !== undefined ? { subject } : {}),
        ...(classId !== undefined ? { class_id: classId } : {}),
        ...(teacherId !== undefined ? { teacher_id: teacherId } : {}),
        ...(statusFilter !== undefined ? { status_filter: statusFilter } : {}),
      });
      const fileName = `bilan_presence_profs_${toSafeFilePart(from)}_${toSafeFilePart(to)}.pdf`;
      const bytes = await renderTeacherAttendanceReport(branding, {
        from,
        to,
        rows: rows.map((row) => ({
          teacherName: row.teacher_name,
          teacherType: row.teacher_type,
          attendanceRate: row.attendance_rate,
          presentCount: row.present_count,
          totalScheduled: row.total_scheduled,
          hoursDone: row.hours_done,
          hoursScheduled: row.hours_scheduled,
          lateCount: row.late_count,
          roomMismatchCount: row.room_mismatch_count,
          rollcallMissingCount: row.rollcall_missing_count,
        })),
      });
      const result = await persistPdf(bytes, fileName);
      return { ...result, fileType: 'pdf' };
    }

    if (job.data.type === 'revenue-export') {
      const { schemaName, periodFrom, periodTo } = job.data;
      // revenueHistory renvoie les N derniers mois ; on borne ensuite sur la
      // période demandée. 36 = plafond accepté par le schéma de l'historique.
      const subscriptionsService = new SubscriptionsService(
        new SubscriptionsRepository(tenantDb)
      );
      const history = await subscriptionsService.revenueHistory(schemaName, 36);
      const filtered = history.filter(
        (item) => item.month >= periodFrom && item.month <= periodTo
      );
      const fileName = `bilan_reversements_${toSafeFilePart(periodFrom)}_${toSafeFilePart(periodTo)}.pdf`;
      const bytes = await renderRevenueReport(branding, {
        periodFrom,
        periodTo,
        rows: filtered.map((item) => ({
          month: item.month,
          subscriptionsNewThisMonth: item.subscriptions_new_this_month,
          subscriptionsActiveCount: item.subscriptions_active_count,
          totalCollectedFcfa: item.total_collected_fcfa,
          commissionDueFcfa: item.commission_due_fcfa,
          commissionPaidFcfa: item.commission_paid_fcfa,
          commissionRemainingFcfa: item.commission_remaining_fcfa,
          paymentStatus: item.payment_status,
        })),
      });
      const result = await persistPdf(bytes, fileName);
      return { ...result, fileType: 'pdf' };
    }

    // salary-export-bulk : un prof (multi-période, un seul PDF) ou tous (zip).
    const months = iterateMonths(job.data.periodFrom, job.data.periodTo);
    const rangeSafe = `${toSafeFilePart(job.data.periodFrom)}_${toSafeFilePart(job.data.periodTo)}`;

    if (job.data.teacherId) {
      const monthly: TeacherSalaryDetails[] = [];
      let teacherName = 'professeur';
      for (const month of months) {
        const payload = await service.getExportTeacherPayload(job.data.teacherId, month);
        teacherName = payload.teacher.name;
        monthly.push(toTeacherDetails(payload));
      }

      const fileName = `bilan_salaire_${toSafeFilePart(teacherName)}_${rangeSafe}.pdf`;
      const bytes = await renderTeacherMultiPeriodBilan(
        branding,
        job.data.periodFrom,
        job.data.periodTo,
        monthly
      );
      const result = await persistPdf(bytes, fileName);
      return { ...result, fileType: 'pdf' };
    }

    // Tous les profs : un PDF multi-période par prof, archivés en zip.
    const teachers = new Map<string, { name: string }>();
    for (const month of months) {
      const summary = await service.getExportSchoolPayload(month);
      for (const item of summary.items) {
        teachers.set(item.teacherId, { name: item.teacherName });
      }
    }

    const entries: Array<{ fileName: string; bytes: Uint8Array }> = [];
    for (const [teacherId, teacher] of teachers.entries()) {
      const monthly: TeacherSalaryDetails[] = [];
      for (const month of months) {
        const payload = await service.getExportTeacherPayload(teacherId, month);
        monthly.push(toTeacherDetails(payload));
      }
      const entryFileName = `bilan_salaire_${toSafeFilePart(teacher.name)}_${rangeSafe}.pdf`;
      const bytes = await renderTeacherMultiPeriodBilan(
        branding,
        job.data.periodFrom,
        job.data.periodTo,
        monthly
      );
      entries.push({ fileName: entryFileName, bytes });
    }

    const zipFileName = `bilans_salaires_${rangeSafe}.zip`;
    const zipResult = await writeZipArchive({ fileName: zipFileName, entries });
    return { ...zipResult, fileType: 'zip' };
  });
};

export const createBillingPdfQueue = (connection: Redis): Queue<BillingPdfJobData> =>
  new Queue<BillingPdfJobData>(BILLING_PDF_QUEUE_NAME, {
    connection,
  });

export const createBillingPdfWorker = (
  connection: Redis
): Worker<BillingPdfJobData, BillingPdfJobResult> =>
  new Worker<BillingPdfJobData, BillingPdfJobResult>(
    BILLING_PDF_QUEUE_NAME,
    async (job) => processBillingPdfJob(job),
    {
      connection,
      concurrency: Number(process.env.BILLING_WORKER_CONCURRENCY ?? 2),
    }
  );

/**
 * Handle minimal de la queue PDF, injecté dans les controllers qui poussent des
 * jobs d'export. Permet d'injecter une fausse queue en test (cf. billing.controller).
 */
export type PdfExportQueueHandle = {
  add: (
    name: string,
    data: BillingPdfJobData,
    options?: { removeOnComplete?: number; removeOnFail?: number }
  ) => Promise<{ id?: string | number }>;
};
