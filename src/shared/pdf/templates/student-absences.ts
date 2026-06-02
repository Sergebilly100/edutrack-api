import type { RGB } from 'pdf-lib';

import { PdfBuilder, type DocumentBranding } from '../builder.js';
import { formatPeriodCoverage } from '../format.js';
import type { PdfTheme } from '../theme.js';

/**
 * Ligne de statistique d'absence d'un élève (forme structurelle issue de
 * `studentsService.getAbsenceStats`, pas d'import croisé de module).
 */
export type StudentAbsenceRow = {
  studentName: string;
  className: string;
  absenceCount: number;
  absenceRate: number | null;
  parentPhone: string | null;
  parentPhone2: string | null;
  smsSummary: 'all_sent' | 'partial' | 'none' | string;
};

export type StudentAbsencesPayload = {
  /** Libellé de l'entité élève (« Élève » / « Apprenant »…) — multi-tenant. */
  studentLabel: string;
  /** Bornes de période au format ISO date (YYYY-MM-DD). */
  from: string;
  to: string;
  rows: StudentAbsenceRow[];
};

const COLUMN_WIDTHS = {
  student: 130,
  absences: 60,
  rate: 56,
  phone1: 92,
  phone2: 92,
  sms: 86,
};

const SMS_LABELS: Record<string, string> = {
  all_sent: 'Notifié',
  partial: 'Partiel',
  none: 'Non notifié',
};

const smsLabel = (summary: string): string => SMS_LABELS[summary] ?? 'Non notifié';

const smsPill = (summary: string, t: PdfTheme): { bg: RGB; fg: RGB } => {
  switch (summary) {
    case 'all_sent':
      return { bg: t.color.successSurface, fg: t.color.success };
    case 'partial':
      return { bg: t.color.warningSurface, fg: t.color.warning };
    default:
      return { bg: t.color.dangerSurface, fg: t.color.danger };
  }
};

const formatPhone = (value: string | null): string => (value ? `+${value}` : '—');
const formatRate = (value: number | null): string => `${(value ?? 0).toFixed(1)} %`;

/**
 * Bilan des absences élèves sur une période : KPIs (élèves concernés, total
 * absences, taux moyen) + détail par élève avec état de notification SMS.
 * Remplace l'ancien export CSV navigateur.
 */
export const renderStudentAbsencesReport = async (
  branding: DocumentBranding,
  payload: StudentAbsencesPayload
): Promise<Uint8Array> => {
  const coverage = formatPeriodCoverage(
    payload.from.slice(0, 7),
    payload.to.slice(0, 7)
  );
  const builder = await PdfBuilder.create(branding, {
    title: 'Bilan des absences',
    subtitle: `${payload.studentLabel}s · ${coverage}`,
  });
  const t = builder.t;

  const totalStudents = payload.rows.length;
  const totalAbsences = payload.rows.reduce((sum, row) => sum + row.absenceCount, 0);
  const avgRate =
    totalStudents > 0
      ? payload.rows.reduce((sum, row) => sum + (row.absenceRate ?? 0), 0) / totalStudents
      : 0;
  const notNotified = payload.rows.filter((row) => row.smsSummary === 'none').length;

  builder.kpiRow([
    { label: `${payload.studentLabel}s concernés`, value: String(totalStudents), accent: t.color.brand },
    { label: 'Total absences', value: String(totalAbsences), accent: t.color.danger, valueColor: t.color.danger },
    { label: "Taux moyen", value: `${avgRate.toFixed(1)} %` },
    {
      label: 'Non notifiés',
      value: String(notNotified),
      accent: t.color.warning,
      valueColor: notNotified > 0 ? t.color.warning : undefined,
    },
  ]);
  builder.space(10);

  if (payload.rows.length === 0) {
    builder.paragraph('Aucune absence enregistrée sur cette période.', { color: t.color.muted });
  } else {
    builder.table({
      title: 'Détail par élève',
      columns: [
        { header: payload.studentLabel, width: COLUMN_WIDTHS.student },
        { header: 'Absences', width: COLUMN_WIDTHS.absences, align: 'right' },
        { header: 'Taux', width: COLUMN_WIDTHS.rate, align: 'right' },
        { header: 'Téléphone 1', width: COLUMN_WIDTHS.phone1 },
        { header: 'Téléphone 2', width: COLUMN_WIDTHS.phone2 },
        { header: 'État SMS', width: COLUMN_WIDTHS.sms, align: 'center' },
      ],
      rows: payload.rows.map((row) => [
        {
          text: `${row.studentName} · ${row.className}`,
          font: builder.f.medium,
        },
        { text: String(row.absenceCount), align: 'right', font: builder.f.semibold },
        { text: formatRate(row.absenceRate), align: 'right' },
        { text: formatPhone(row.parentPhone), color: t.color.muted },
        { text: formatPhone(row.parentPhone2), color: t.color.muted },
        { text: smsLabel(row.smsSummary), pill: smsPill(row.smsSummary, t) },
      ]),
    });
  }

  builder.signatureBlock();
  return builder.save();
};
