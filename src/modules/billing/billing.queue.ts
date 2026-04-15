import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { withTenantSchema } from '../../shared/database/db.js';

import { buildBillingService } from './billing.service.js';

export const BILLING_PDF_QUEUE_NAME = 'pdf-exports';

const EXPORT_DIR = '/tmp/edutrack-exports';

const toSafeFilePart = (value: string): string => value.replace(/[^a-zA-Z0-9_-]+/g, '_');

const writeSimplePdf = async (params: {
  title: string;
  subtitle: string;
  lines: string[];
  fileName: string;
}): Promise<{ filePath: string; fileName: string; generatedAt: string }> => {
  await mkdir(EXPORT_DIR, { recursive: true });

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

  const bytes = await pdf.save();
  const filePath = path.join(EXPORT_DIR, params.fileName);
  await writeFile(filePath, bytes);

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
    };

export type BillingPdfJobResult = {
  filePath: string;
  fileName: string;
  generatedAt: string;
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

      const lines = [
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

      return writeSimplePdf({
        title: 'Bilan Salaire Professeur',
        subtitle: `Export genere automatiquement - job ${job.id ?? ''}`,
        lines,
        fileName,
      });
    }

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

    return writeSimplePdf({
      title: 'Bilan Salaires Ecole',
      subtitle: `Export global - job ${job.id ?? ''}`,
      lines,
      fileName,
    });
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
