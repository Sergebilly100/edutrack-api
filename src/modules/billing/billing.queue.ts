import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import archiver from 'archiver';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { withTenantSchema } from '../../shared/database/db.js';

import { buildBillingService } from './billing.service.js';

export const BILLING_PDF_QUEUE_NAME = 'pdf-exports';

export const BILLING_EXPORT_DIR = '/tmp/edutrack-exports';

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

const formatMonthLabel = (month: string): string => {
  const date = toMonthDateUtc(month);
  return new Intl.DateTimeFormat('fr-FR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
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

const buildTeacherExportLines = (details: TeacherExportPayload): string[] => {
  return [
    `Professeur: ${details.teacher.name}`,
    `Mois: ${details.month}`,
    `Type: ${details.teacher.type}`,
    `Taux horaire: ${details.teacher.hourlyRate ?? 'Salaire fixe'}`,
    `Heures prevues: ${details.summary.hoursPlanned.toFixed(2)}`,
    `Heures effectuees: ${details.summary.hoursDone.toFixed(2)}`,
    `Total FCFA: ${details.summary.totalFcfa ?? 'N/A'}`,
    '',
    'Details jour par jour:',
    ...details.rows.map(
      (row) =>
        `${row.date} | ${row.slotLabel} | ${row.subject} (${row.className}) | ${row.attendanceStatus} | ${row.hoursDone.toFixed(2)}h`
    ),
  ];
};

const createSimplePdfBytes = async (params: {
  title: string;
  subtitle: string;
  lines: string[];
}): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  let page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  page.drawText('LOGO ECOLE (placeholder)', {
    x: 40,
    y: 790,
    size: 10,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  page.drawText(params.title, {
    x: 40,
    y: 760,
    size: 18,
    font: boldFont,
  });

  page.drawText(params.subtitle, {
    x: 40,
    y: 738,
    size: 11,
    font,
  });

  let cursorY = 710;
  for (const line of params.lines) {
    if (cursorY < 60) {
      cursorY = 760;
      page = pdf.addPage([595, 842]);
    }

    page.drawText(line, {
      x: 40,
      y: cursorY,
      size: 10,
      font,
    });
    cursorY -= 16;
  }

  page.drawText('Signature directeur: ___________________________', {
    x: 40,
    y: 40,
    size: 10,
    font,
  });

  return pdf.save();
};

const writeSimplePdf = async (params: {
  title: string;
  subtitle: string;
  lines: string[];
  fileName: string;
}): Promise<{ filePath: string; fileName: string; generatedAt: string }> => {
  await mkdir(BILLING_EXPORT_DIR, { recursive: true });
  const bytes = await createSimplePdfBytes(params);
  const filePath = path.join(BILLING_EXPORT_DIR, params.fileName);
  await writeFile(filePath, bytes);
  return {
    filePath,
    fileName: params.fileName,
    generatedAt: new Date().toISOString(),
  };
};

const writeZipArchive = async (params: {
  fileName: string;
  entries: Array<{ fileName: string; bytes: Uint8Array }>;
}): Promise<{ filePath: string; fileName: string; generatedAt: string }> => {
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

  return {
    filePath,
    fileName: params.fileName,
    generatedAt: new Date().toISOString(),
  };
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
    };

export type BillingPdfJobResult = {
  filePath: string;
  fileName: string;
  generatedAt: string;
  fileType: 'pdf' | 'zip';
};

export const processBillingPdfJob = async (
  job: Job<BillingPdfJobData>
): Promise<BillingPdfJobResult> => {
  return withTenantSchema(job.data.schemaName, async (tenantDb) => {
    const service = buildBillingService(tenantDb);

    if (job.data.type === 'salary-export-teacher') {
      const details = await service.getExportTeacherPayload(job.data.teacherId, job.data.month);
      const monthSafe = toSafeFilePart(job.data.month);
      const teacherSafe = toSafeFilePart(details.teacher.name);
      const fileName = `salary_teacher_${teacherSafe}_${monthSafe}.pdf`;

      const lines = buildTeacherExportLines(details);

      const result = await writeSimplePdf({
        title: 'Bilan Salaire Professeur',
        subtitle: `Export genere automatiquement - job ${job.id ?? ''}`,
        lines,
        fileName,
      });
      return {
        ...result,
        fileType: 'pdf',
      };
    }

    if (job.data.type === 'salary-export-school') {
      const summary = await service.getExportSchoolPayload(job.data.month);
      const monthSafe = toSafeFilePart(job.data.month);
      const fileName = `salary_school_${monthSafe}.pdf`;

      const lines = [
        `Mois: ${summary.month}`,
        '',
        ...summary.items.map(
          (item) =>
            `${item.teacherName} | ${item.teacherType} | prevu=${item.hoursPlanned.toFixed(2)}h | fait=${item.hoursDone.toFixed(2)}h | total=${item.totalFcfa ?? 'N/A'} | statut=${item.status}`
        ),
      ];

      const result = await writeSimplePdf({
        title: 'Bilan Salaires Ecole',
        subtitle: `Export global - job ${job.id ?? ''}`,
        lines,
        fileName,
      });

      return {
        ...result,
        fileType: 'pdf',
      };
    }

    const months = iterateMonths(job.data.periodFrom, job.data.periodTo);
    const rangeSafe = `${toSafeFilePart(job.data.periodFrom)}_${toSafeFilePart(job.data.periodTo)}`;

    if (job.data.teacherId) {
      const allLines: string[] = [];
      let teacherName = 'teacher';
      let teacherType: 'vacataire' | 'permanent' = 'vacataire';

      for (const month of months) {
        const details = await service.getExportTeacherPayload(job.data.teacherId, month);
        teacherName = details.teacher.name;
        teacherType = details.teacher.type;

        allLines.push(`=== ${formatMonthLabel(month)} ===`);
        allLines.push(...buildTeacherExportLines(details));
        allLines.push('');
      }

      const teacherSafe = toSafeFilePart(teacherName);
      const fileName = `salary_teacher_${teacherSafe}_${rangeSafe}.pdf`;
      const result = await writeSimplePdf({
        title: 'Bilan Salaire Professeur (multi-periode)',
        subtitle: `${teacherName} - ${teacherType} - job ${job.id ?? ''}`,
        lines: allLines,
        fileName,
      });

      return {
        ...result,
        fileType: 'pdf',
      };
    }

    const teachers = new Map<string, { name: string; type: 'vacataire' | 'permanent' }>();
    for (const month of months) {
      const summary = await service.getExportSchoolPayload(month);
      for (const item of summary.items) {
        teachers.set(item.teacherId, { name: item.teacherName, type: item.teacherType });
      }
    }

    const entries: Array<{ fileName: string; bytes: Uint8Array }> = [];

    for (const [teacherId, teacher] of teachers.entries()) {
      const lines: string[] = [];

      for (const month of months) {
        const details = await service.getExportTeacherPayload(teacherId, month);
        lines.push(`=== ${formatMonthLabel(month)} ===`);
        lines.push(...buildTeacherExportLines(details));
        lines.push('');
      }

      const teacherSafe = toSafeFilePart(teacher.name);
      const entryFileName = `salary_teacher_${teacherSafe}_${rangeSafe}.pdf`;
      const bytes = await createSimplePdfBytes({
        title: 'Bilan Salaire Professeur (multi-periode)',
        subtitle: `${teacher.name} - ${teacher.type} - job ${job.id ?? ''}`,
        lines,
      });
      entries.push({ fileName: entryFileName, bytes });
    }

    const zipFileName = `salary_bulk_${rangeSafe}.zip`;
    const zipResult = await writeZipArchive({
      fileName: zipFileName,
      entries,
    });

    return {
      ...zipResult,
      fileType: 'zip',
    };
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
    }
  );
