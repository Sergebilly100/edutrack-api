import type { RGB } from 'pdf-lib';

import { PdfBuilder, type DocumentBranding } from '../builder.js';
import { formatHours, formatPeriodCoverage, teacherTypeLabel } from '../format.js';
import type { PdfTheme } from '../theme.js';

/**
 * Ligne de statistique de présence d'un professeur (forme structurelle issue de
 * `teacherStatsService.getStats`, pas d'import croisé de module).
 */
export type TeacherAttendanceRow = {
  teacherName: string;
  teacherType: string;
  attendanceRate: number;
  presentCount: number;
  totalScheduled: number;
  hoursDone: number;
  hoursScheduled: number;
  lateCount: number;
  roomMismatchCount: number;
  rollcallMissingCount: number;
};

export type TeacherAttendancePayload = {
  /** Bornes de période au format ISO date (YYYY-MM-DD). */
  from: string;
  to: string;
  rows: TeacherAttendanceRow[];
};

const COLUMN_WIDTHS = {
  teacher: 130,
  type: 64,
  rate: 60,
  present: 64,
  hours: 80,
  late: 50,
  anomalies: 86,
};

const ratePill = (rate: number, t: PdfTheme): { bg: RGB; fg: RGB } => {
  if (rate >= 80) return { bg: t.color.successSurface, fg: t.color.success };
  if (rate >= 50) return { bg: t.color.warningSurface, fg: t.color.warning };
  return { bg: t.color.dangerSurface, fg: t.color.danger };
};

/**
 * Bilan de présence des professeurs sur une période : KPIs (profs suivis, taux
 * moyen, retards, anomalies) + détail par professeur.
 * Remplace l'ancien export CSV navigateur.
 */
export const renderTeacherAttendanceReport = async (
  branding: DocumentBranding,
  payload: TeacherAttendancePayload
): Promise<Uint8Array> => {
  const coverage = formatPeriodCoverage(payload.from.slice(0, 7), payload.to.slice(0, 7));
  const builder = await PdfBuilder.create(branding, {
    title: 'Bilan de présence — professeurs',
    subtitle: coverage,
  });
  const t = builder.t;

  const totalTeachers = payload.rows.length;
  const avgRate =
    totalTeachers > 0
      ? payload.rows.reduce((sum, row) => sum + row.attendanceRate, 0) / totalTeachers
      : 0;
  const totalLate = payload.rows.reduce((sum, row) => sum + row.lateCount, 0);
  const totalAnomalies = payload.rows.reduce(
    (sum, row) => sum + row.roomMismatchCount + row.rollcallMissingCount,
    0
  );

  builder.kpiRow([
    { label: 'Professeurs', value: String(totalTeachers), accent: t.color.brand },
    { label: 'Taux moyen', value: `${avgRate.toFixed(1)} %` },
    {
      label: 'Retards',
      value: String(totalLate),
      accent: t.color.warning,
      valueColor: totalLate > 0 ? t.color.warning : undefined,
    },
    {
      label: 'Anomalies',
      value: String(totalAnomalies),
      accent: t.color.danger,
      valueColor: totalAnomalies > 0 ? t.color.danger : undefined,
    },
  ]);
  builder.space(10);

  if (payload.rows.length === 0) {
    builder.paragraph('Aucune donnée de présence sur cette période.', { color: t.color.muted });
  } else {
    builder.table({
      title: 'Détail par professeur',
      columns: [
        { header: 'Professeur', width: COLUMN_WIDTHS.teacher },
        { header: 'Type', width: COLUMN_WIDTHS.type },
        { header: 'Taux', width: COLUMN_WIDTHS.rate, align: 'center' },
        { header: 'Présences', width: COLUMN_WIDTHS.present, align: 'right' },
        { header: 'Heures', width: COLUMN_WIDTHS.hours, align: 'right' },
        { header: 'Retards', width: COLUMN_WIDTHS.late, align: 'right' },
        { header: 'Anomalies', width: COLUMN_WIDTHS.anomalies, align: 'center' },
      ],
      rows: payload.rows.map((row) => {
        const anomalies = row.roomMismatchCount + row.rollcallMissingCount;
        return [
          { text: row.teacherName, font: builder.f.medium },
          { text: teacherTypeLabel(row.teacherType) },
          {
            text: `${Math.round(row.attendanceRate)} %`,
            pill: ratePill(row.attendanceRate, t),
          },
          { text: `${row.presentCount}/${row.totalScheduled}`, align: 'right' },
          {
            text: `${formatHours(row.hoursDone)} / ${formatHours(row.hoursScheduled)}`,
            align: 'right',
          },
          {
            text: String(row.lateCount),
            align: 'right',
            color: row.lateCount > 0 ? t.color.warning : t.color.muted,
          },
          {
            text: anomalies > 0 ? String(anomalies) : 'OK',
            align: 'center',
            color: anomalies > 0 ? t.color.danger : t.color.success,
          },
        ];
      }),
    });
  }

  builder.signatureBlock();
  return builder.save();
};
