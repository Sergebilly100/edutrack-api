import type { TeacherQrAlertPayload } from '../../shared/events/events.types.js';

export const SMS_MAX_LENGTH = 159;

type TeacherLateSmsParams = {
  teacherName: string;
  lateMinutes: number;
  subject: string;
  className: string;
  slotLabel: string;
  date: string;
};

type TeacherQrMismatchSmsParams = {
  teacherName: string;
  scannedRoom: string;
  expectedRoom: string;
  subject: string;
  slotLabel: string;
};

type TeacherQrMissingScanSmsParams = {
  teacherName: string;
  subject: string;
  className: string;
  slotLabel: string;
};

type TeacherQrOutOfTimeSmsParams = {
  teacherName: string;
  subject: string;
  date: string;
  slotLabel: string;
};

type StudentAbsentSmsParams = {
  studentFirstName: string;
  subject: string;
  date: string;
  schoolPhone: string;
};

type PaymentReminderSmsParams = {
  schoolName: string;
  periodLabel: string;
  dueDate: string;
  remainingAmountFcfa: number;
};

type TeacherDailySummarySmsParams = {
  date: string;
  absentCount: number;
  lateCount: number;
  presentCount: number;
  totalCourses: number;
};

const ELLIPSIS = '...';

const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const limitSmsLength = (message: string): string => {
  const normalized = normalizeText(message);
  if (normalized.length <= SMS_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, SMS_MAX_LENGTH - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
};

const safeText = (value: string | null | undefined, fallback = 'N/A'): string => {
  if (!value) {
    return fallback;
  }

  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : fallback;
};

export const renderSmsTemplate = (
  template: string,
  variables: Record<string, string | number | null | undefined>
): string => {
  const rendered = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = variables[key];
    return safeText(value === undefined || value === null ? undefined : String(value));
  });

  return limitSmsLength(rendered);
};

export const buildTeacherLateSms = (params: TeacherLateSmsParams): string => {
  return limitSmsLength(
    `EduTrack: ${safeText(params.teacherName)} en retard de ${params.lateMinutes}min - ${safeText(params.subject)} (${safeText(params.className)}, ${safeText(params.slotLabel)}). ${safeText(params.date)}`
  );
};

export const buildTeacherQrAlertSms = (
  alertType: TeacherQrAlertPayload['alertType'],
  params:
    | TeacherQrMismatchSmsParams
    | TeacherQrMissingScanSmsParams
    | TeacherQrOutOfTimeSmsParams
): string => {
  if (alertType === 'teacher_qr_mismatch') {
    const mismatchParams = params as TeacherQrMismatchSmsParams;
    return limitSmsLength(
      `EduTrack: ${safeText(mismatchParams.teacherName)} a scanné salle ${safeText(mismatchParams.scannedRoom)} au lieu de ${safeText(mismatchParams.expectedRoom)} - ${safeText(mismatchParams.subject)} ${safeText(mismatchParams.slotLabel)}`
    );
  }

  if (alertType === 'teacher_qr_missing_scan') {
    const missingParams = params as TeacherQrMissingScanSmsParams;
    return limitSmsLength(
      `EduTrack: ${safeText(missingParams.teacherName)} n'a pas scanné le QR de sa salle - ${safeText(missingParams.subject)} (${safeText(missingParams.className)}) ${safeText(missingParams.slotLabel)}`
    );
  }

  const outOfTimeParams = params as TeacherQrOutOfTimeSmsParams;
  return limitSmsLength(
    `EduTrack: Scan QR hors horaire par ${safeText(outOfTimeParams.teacherName)} - ${safeText(outOfTimeParams.subject)} ${safeText(outOfTimeParams.date)} ${safeText(outOfTimeParams.slotLabel)}`
  );
};

export const buildStudentAbsentSms = (params: StudentAbsentSmsParams): string => {
  return limitSmsLength(
    `EduTrack: ${safeText(params.studentFirstName)} absent(e) en ${safeText(params.subject)} le ${safeText(params.date)}. Contact école: ${safeText(params.schoolPhone)}`
  );
};

export const buildPaymentReminderSms = (params: PaymentReminderSmsParams): string => {
  const amount = new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 0,
  }).format(Math.max(0, params.remainingAmountFcfa));

  return limitSmsLength(
    `EduTrack: relance paiement ${safeText(params.schoolName)}. Échéance ${safeText(params.dueDate)}, période ${safeText(params.periodLabel)}, reste ${amount} FCFA.`
  );
};

export const buildTeacherDailySummarySms = (params: TeacherDailySummarySmsParams): string => {
  return limitSmsLength(
    `EduTrack: Point profs ${safeText(params.date)} - ${params.absentCount} absent(s), ${params.lateCount} retard(s), ${params.presentCount}/${params.totalCourses} cours assures. Voir dashboard.`
  );
};
