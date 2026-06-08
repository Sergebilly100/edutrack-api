import type { RGB } from 'pdf-lib';

import type { PdfTheme } from './theme.js';

/**
 * Formateurs partagés pour tous les bilans PDF.
 * Tout est localisé en fr-FR / Africa/Abidjan, monnaie FCFA.
 */

const FCFA = new Intl.NumberFormat('fr-FR', { useGrouping: true });

/** « 125 000 FCFA ». null → « -. ». */
export const formatFcfa = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '-';
  }
  return `${FCFA.format(Math.round(value))} FCFA`;
};

/** « 12,5 h ». */
export const formatHours = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '-';
  }
  const rounded = Math.round(value * 100) / 100;
  return `${rounded.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} h`;
};

/** « 15 mai 2026 ». ISO date ou datetime accepté. */
export const formatDate = (value: string | Date | null | undefined): string => {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'long',
    timeZone: 'Africa/Abidjan',
  }).format(date);
};

/** « 15 mai 2026 à 08:12 ». */
export const formatDateTime = (value: string | Date | null | undefined): string => {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Africa/Abidjan',
  }).format(date);
};

const MONTH_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const MONTH_ONLY = new Intl.DateTimeFormat('fr-FR', { month: 'long', timeZone: 'UTC' });

const monthToUtc = (month: string): Date | null => {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return new Date(Date.UTC(y, m - 1, 1));
};

/** « 2026-05 » → « mai 2026 ». */
export const formatMonthLabel = (month: string): string => {
  const date = monthToUtc(month);
  return date ? capitalize(MONTH_FORMAT.format(date)) : month;
};

/**
 * Libellé de période couverte : « Janvier – Avril 2026 ».
 * Gère le changement d'année : « Décembre 2025 – Mars 2026 ».
 */
export const formatPeriodCoverage = (from: string, to: string): string => {
  const start = monthToUtc(from);
  const end = monthToUtc(to);
  if (!start || !end) return `${from} – ${to}`;
  if (from === to) return formatMonthLabel(from);

  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  if (sameYear) {
    return `${capitalize(MONTH_ONLY.format(start))} – ${capitalize(MONTH_ONLY.format(end))} ${end.getUTCFullYear()}`;
  }
  return `${formatMonthLabel(from)} – ${formatMonthLabel(to)}`;
};

const capitalize = (value: string): string =>
  value.length ? value[0]!.toUpperCase() + value.slice(1) : value;

// ── Statuts métier ────────────────────────────────────────────────────────

export type SalaryStatus = 'paid' | 'pending' | 'disputed' | 'nothing_to_pay' | string;

export const SALARY_STATUS_LABELS: Record<string, string> = {
  paid: 'Payé',
  pending: 'En attente',
  disputed: 'Litige',
  nothing_to_pay: 'Rien à payer',
};

export const formatSalaryStatus = (status: SalaryStatus): string =>
  SALARY_STATUS_LABELS[status] ?? status;

/** Pastille colorée (bg/fg) pour un statut de paiement. */
export const salaryStatusPill = (
  status: SalaryStatus,
  theme: PdfTheme
): { bg: RGB; fg: RGB } => {
  switch (status) {
    case 'paid':
      return { bg: theme.color.successSurface, fg: theme.color.success };
    case 'disputed':
      return { bg: theme.color.dangerSurface, fg: theme.color.danger };
    case 'nothing_to_pay':
      return { bg: theme.color.neutralSurface, fg: theme.color.neutralText };
    case 'pending':
    default:
      return { bg: theme.color.warningSurface, fg: theme.color.warning };
  }
};

export type AttendanceStatus =
  | 'present'
  | 'late'
  | 'absent'
  | 'excused'
  | 'not_marked'
  | string;

export const ATTENDANCE_STATUS_LABELS: Record<string, string> = {
  present: 'Présent',
  late: 'Retard',
  absent: 'Absent',
  excused: 'Excusé',
  not_marked: 'Non pointé',
};

export const formatAttendanceStatus = (
  status: AttendanceStatus,
  lateMinutes?: number | null
): string => {
  if (status === 'late' && lateMinutes && lateMinutes > 0) {
    return `Retard ${lateMinutes} min`;
  }
  return ATTENDANCE_STATUS_LABELS[status] ?? status;
};

export const attendanceStatusPill = (
  status: AttendanceStatus,
  theme: PdfTheme
): { bg: RGB; fg: RGB } => {
  switch (status) {
    case 'present':
    case 'excused':
      return { bg: theme.color.successSurface, fg: theme.color.success };
    case 'late':
      return { bg: theme.color.warningSurface, fg: theme.color.warning };
    case 'absent':
      return { bg: theme.color.dangerSurface, fg: theme.color.danger };
    default:
      return { bg: theme.color.neutralSurface, fg: theme.color.neutralText };
  }
};

export const formatCompensation = (
  type: 'vacataire' | 'permanent' | string,
  hourlyRate: number | null,
  monthlySalary: number | null
): string => {
  if (type === 'permanent') {
    return monthlySalary !== null ? `${formatFcfa(monthlySalary)} / mois` : 'Salaire non renseigné';
  }
  return hourlyRate !== null ? `${formatFcfa(hourlyRate)} / h` : 'Taux non renseigné';
};

export const teacherTypeLabel = (type: string): string =>
  type === 'permanent' ? 'Permanent' : 'Vacataire';
