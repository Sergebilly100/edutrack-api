import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import archiver from 'archiver';
import { sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { db } from '../../shared/database/db.js';
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

type SchoolBranding = {
  schoolName: string;
  logoUrl: string | null;
};

type LoadedLogo = {
  bytes: Uint8Array;
  format: 'png' | 'jpg';
};

type PdfBranding = {
  schoolName: string;
  logo: LoadedLogo | null;
};

const DEFAULT_SCHOOL_NAME = 'École';

const fetchSchoolBranding = async (schemaName: string): Promise<SchoolBranding> => {
  const result = await db.execute<{ name: string | null; logo_url: string | null }>(sql`
    SELECT name, logo_url
    FROM public.tenants
    WHERE schema_name = ${schemaName}
    LIMIT 1
  `);

  const row = result.rows[0];
  if (!row) {
    return {
      schoolName: DEFAULT_SCHOOL_NAME,
      logoUrl: null,
    };
  }

  return {
    schoolName: row.name?.trim() || DEFAULT_SCHOOL_NAME,
    logoUrl: row.logo_url?.trim() || null,
  };
};

const parseDataUri = (value: string): { contentType: string; data: Uint8Array } | null => {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value.trim());
  if (!match) {
    return null;
  }

  const [, contentType, base64Body] = match;
  try {
    return {
      contentType,
      data: Uint8Array.from(Buffer.from(base64Body, 'base64')),
    };
  } catch {
    return null;
  }
};

const detectImageFormat = (bytes: Uint8Array, contentType?: string): 'png' | 'jpg' | null => {
  if (bytes.length >= 8) {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const isPng = pngSignature.every((value, index) => bytes[index] === value);
    if (isPng) {
      return 'png';
    }
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }

  const normalizedType = contentType?.toLowerCase() ?? '';
  if (normalizedType.includes('png')) {
    return 'png';
  }
  if (normalizedType.includes('jpeg') || normalizedType.includes('jpg')) {
    return 'jpg';
  }

  return null;
};

const loadLogo = async (logoUrl: string | null): Promise<LoadedLogo | null> => {
  if (!logoUrl) {
    return null;
  }

  const dataUri = parseDataUri(logoUrl);
  if (dataUri) {
    const format = detectImageFormat(dataUri.data, dataUri.contentType);
    if (!format) {
      return null;
    }

    return {
      bytes: dataUri.data,
      format,
    };
  }

  if (!/^https?:\/\//i.test(logoUrl)) {
    return null;
  }

  try {
    const response = await fetch(logoUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const format = detectImageFormat(bytes, response.headers.get('content-type') ?? undefined);
    if (!format) {
      return null;
    }

    return {
      bytes,
      format,
    };
  } catch {
    return null;
  }
};

const buildTeacherExportLines = (details: TeacherExportPayload): string[] => {
  const compensationLine =
    details.teacher.type === 'permanent'
      ? `Salaire mensuel: ${details.teacher.monthlySalary ?? 'Non renseigne'}`
      : `Taux horaire: ${details.teacher.hourlyRate ?? 'Non renseigne'}`;

  return [
    `Professeur: ${details.teacher.name}`,
    `Mois: ${details.month}`,
    `Type: ${details.teacher.type}`,
    compensationLine,
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
  branding?: PdfBranding;
}): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  let page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const schoolName = params.branding?.schoolName ?? DEFAULT_SCHOOL_NAME;
  const embeddedLogo = params.branding?.logo
    ? params.branding.logo.format === 'png'
      ? await pdf.embedPng(params.branding.logo.bytes)
      : await pdf.embedJpg(params.branding.logo.bytes)
    : null;

  const drawHeader = (targetPage: typeof page) => {
    const pageWidth = targetPage.getWidth();
    const logoMaxWidth = 72;
    const logoMaxHeight = 72;

    if (embeddedLogo) {
      const scale = Math.min(
        logoMaxWidth / embeddedLogo.width,
        logoMaxHeight / embeddedLogo.height,
        1
      );
      const width = embeddedLogo.width * scale;
      const height = embeddedLogo.height * scale;
      targetPage.drawImage(embeddedLogo, {
        x: pageWidth - 40 - width,
        y: 760,
        width,
        height,
      });
    }

    targetPage.drawText(params.title, {
      x: 40,
      y: 760,
      size: 18,
      font: boldFont,
    });

    targetPage.drawText(params.subtitle, {
      x: 40,
      y: 740,
      size: 11,
      font,
    });

    targetPage.drawText(`Ecole: ${schoolName}`, {
      x: 40,
      y: 724,
      size: 10,
      font,
      color: rgb(0.3, 0.3, 0.3),
    });
  };

  drawHeader(page);

  let cursorY = 695;
  for (const line of params.lines) {
    if (cursorY < 60) {
      cursorY = 695;
      page = pdf.addPage([595, 842]);
      drawHeader(page);
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
  branding?: PdfBranding;
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
  const schoolBranding = await fetchSchoolBranding(job.data.schemaName);
  const branding: PdfBranding = {
    schoolName: schoolBranding.schoolName,
    logo: await loadLogo(schoolBranding.logoUrl),
  };

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
        branding,
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
        branding,
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
        branding,
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
        branding,
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
