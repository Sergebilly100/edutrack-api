import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import archiver from 'archiver';
import { sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { db, withTenantSchema } from '../../shared/database/db.js';
import { logger as appLogger } from '../../shared/observability/logger.js';
import { isR2Configured, uploadBuffer } from '../../shared/storage/r2.js';

import { buildBillingService } from './billing.service.js';

export const BILLING_PDF_QUEUE_NAME = 'pdf-exports';

// Configurable via variable d'environnement (fallback: /tmp pour dev local)
// En production Railway, utiliser un volume persistant ou un stockage cloud (R2/S3)
export const BILLING_EXPORT_DIR = process.env.BILLING_EXPORT_DIR ?? '/tmp/edutrack-exports';

const toSafeFilePart = (value: string): string => value.replace(/[^a-zA-Z0-9_-]+/g, '_');

/**
 * Formate le statut de paiement pour l'affichage dans les PDFs.
 */
const formatPaymentStatus = (status: string): string => {
  switch (status) {
    case 'paid':
      return 'Payé';
    case 'disputed':
      return 'Litige';
    case 'pending':
      return 'En attente';
    case 'nothing_to_pay':
      return 'Rien à payer';
    default:
      return status;
  }
};

/**
 * Formate le type de rémunération pour l'affichage dans les PDFs.
 */
const formatCompensationType = (
  teacherType: 'vacataire' | 'permanent',
  hourlyRate: number | null,
  monthlySalary: number | null
): string => {
  if (teacherType === 'permanent') {
    return `Salaire mensuel: ${monthlySalary ?? 'Non renseigné'} FCFA`;
  }
  return `Taux horaire: ${hourlyRate ?? 'Non renseigné'} FCFA/h`;
};

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

/**
 * Télécharge le logo école avec retry automatique (backoff exponentiel).
 * Logs les échecs pour monitoring via Sentry.
 */
const loadLogo = async (logoUrl: string | null, logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }): Promise<LoadedLogo | null> => {
  if (!logoUrl) {
    return null;
  }

  // Cas 1: Data URI (déjà encodé en base64)
  const dataUri = parseDataUri(logoUrl);
  if (dataUri) {
    const format = detectImageFormat(dataUri.data, dataUri.contentType);
    if (!format) {
      logger?.warn('[billing] Invalid image format in data URI', { logoUrl: logoUrl.slice(0, 50) });
      return null;
    }

    return {
      bytes: dataUri.data,
      format,
    };
  }

  // Cas 2: URL HTTP(S)
  if (!/^https?:\/\//i.test(logoUrl)) {
    logger?.warn('[billing] Invalid logo URL (not http/https)', { logoUrl });
    return null;
  }

  // Retry avec backoff exponentiel : 3 tentatives (0ms, 500ms, 2000ms)
  const maxRetries = 3;
  const baseDelay = 500;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(logoUrl, {
        signal: AbortSignal.timeout(8000), // Augmenté de 5s à 8s
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const format = detectImageFormat(bytes, response.headers.get('content-type') ?? undefined);

      if (!format) {
        logger?.warn('[billing] Invalid image format from URL', { logoUrl, contentType: response.headers.get('content-type') });
        return null;
      }

      // Succès !
      if (attempt > 0) {
        logger?.warn('[billing] Logo loaded after retry', { logoUrl, attempt: attempt + 1 });
      }

      return {
        bytes,
        format,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries - 1) {
        // Attendre avant de retry (backoff exponentiel)
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // Échec après tous les retries
  logger?.warn('[billing] Failed to load logo after retries', {
    logoUrl,
    attempts: maxRetries,
    error: lastError?.message,
  });

  return null;
};

const buildTeacherExportLines = (details: TeacherExportPayload): string[] => {
  const compensationLine = formatCompensationType(
    details.teacher.type,
    details.teacher.hourlyRate,
    details.teacher.monthlySalary
  );

  const paymentDateLine = details.payment.paidAt
    ? `Dernier paiement: ${new Date(details.payment.paidAt).toISOString()}`
    : 'Dernier paiement: Aucun';

  const paymentNoteLine = details.payment.notes
    ? `Note paiement: ${details.payment.notes}`
    : 'Note paiement: -';

  return [
    `Professeur: ${details.teacher.name}`,
    `Mois: ${details.month}`,
    `Type: ${details.teacher.type}`,
    compensationLine,
    `Statut paiement: ${formatPaymentStatus(details.summary.status)}`,
    paymentDateLine,
    `Montant deja paye: ${details.summary.amountAlreadyPaid ?? 0} FCFA`,
    `Montant restant a payer: ${details.summary.amountRemainingToPayNow ?? 0} FCFA`,
    paymentNoteLine,
    `Heures prevues: ${details.summary.hoursPlanned.toFixed(2)}h`,
    `Heures effectuees: ${details.summary.hoursDone.toFixed(2)}h`,
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

type ExportArtifact = {
  filePath: string;
  fileName: string;
  generatedAt: string;
  r2Key?: string;
};

// R2 objects live under this prefix and survive instance restarts. Keep a flat layout —
// jobId in the filename is unique enough to avoid collisions across tenants.
const buildR2Key = (fileName: string): string => `billing/exports/${fileName}`;

const writeSimplePdf = async (params: {
  title: string;
  subtitle: string;
  lines: string[];
  fileName: string;
  branding?: PdfBranding;
}): Promise<ExportArtifact> => {
  const bytes = await createSimplePdfBytes(params);
  const generatedAt = new Date().toISOString();

  if (isR2Configured()) {
    const r2Key = buildR2Key(params.fileName);
    await uploadBuffer(r2Key, Buffer.from(bytes), 'application/pdf');
    // filePath kept empty-ish for the legacy return type; the download endpoint
    // checks r2Key first and only falls back to filePath when R2 is off.
    return { filePath: '', fileName: params.fileName, generatedAt, r2Key };
  }

  await mkdir(BILLING_EXPORT_DIR, { recursive: true });
  const filePath = path.join(BILLING_EXPORT_DIR, params.fileName);
  await writeFile(filePath, bytes);
  return { filePath, fileName: params.fileName, generatedAt };
};

const writeZipArchive = async (params: {
  fileName: string;
  entries: Array<{ fileName: string; bytes: Uint8Array }>;
}): Promise<ExportArtifact> => {
  const generatedAt = new Date().toISOString();

  if (isR2Configured()) {
    // Build the archive in-memory then upload — avoids needing disk space at all.
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
  const schoolBranding = await fetchSchoolBranding(job.data.schemaName);

  // Logger contextualisé pour le job courant
  const logger = {
    warn: (msg: string, meta?: Record<string, unknown>) => {
      appLogger.warn({ jobId: job.id, ...(meta ?? {}) }, msg);
    },
  };

  const branding: PdfBranding = {
    schoolName: schoolBranding.schoolName,
    logo: await loadLogo(schoolBranding.logoUrl, logger),
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
      concurrency: Number(process.env.BILLING_WORKER_CONCURRENCY ?? 2),
    }
  );
