import { PdfBuilder, type DocumentBranding } from '../builder.js';
import {
  attendanceStatusPill,
  formatAttendanceStatus,
  formatDate,
  formatPeriodCoverage,
} from '../format.js';

/**
 * Détail d'une séance enseignée, tel que produit par
 * `attendanceService.exportTeacherHistory` (forme structurelle, pas d'import
 * croisé de module - cf. AGENTS.md).
 */
export type TeacherHoursRow = {
  date: string;
  subject: string;
  className: string;
  roomName: string;
  startTime: string;
  endTime: string;
  attendanceStatus: string | null;
  lateMinutes: number | null;
  rollcallDone: boolean;
  studentPresentCount: number;
  studentAbsentCount: number;
  studentTotalCount: number;
};

export type TeacherHoursPayload = {
  teacher: { name: string };
  periodFrom: string;
  periodTo: string;
  rows: TeacherHoursRow[];
};

const COLUMN_WIDTHS = {
  date: 64,
  slot: 70,
  subject: 118,
  room: 56,
  status: 78,
  rollcall: 70,
};

const slotLabel = (start: string, end: string): string => {
  const trim = (value: string): string => (value ? value.slice(0, 5) : '-');
  return `${trim(start)} – ${trim(end)}`;
};

/**
 * Bilan des heures d'un professeur sur une période : KPIs (séances, heures
 * faites, retards, taux de présence) + détail séance par séance.
 * Remplace l'ancien export Excel synchrone.
 */
export const renderTeacherHoursReport = async (
  branding: DocumentBranding,
  payload: TeacherHoursPayload
): Promise<Uint8Array> => {
  const coverage = formatPeriodCoverage(payload.periodFrom, payload.periodTo);
  const builder = await PdfBuilder.create(branding, {
    title: 'Bilan des heures',
    subtitle: `${payload.teacher.name} · ${coverage}`,
  });
  const t = builder.t;

  const totalSessions = payload.rows.length;
  const presentSessions = payload.rows.filter(
    (row) => row.attendanceStatus === 'present' || row.attendanceStatus === 'late'
  ).length;
  const lateSessions = payload.rows.filter((row) => row.attendanceStatus === 'late').length;
  // 1h par séance comme base d'estimation des heures faites (le détail Présents/
  // Absents reste dans la table). On agrège ce qui est disponible côté export.
  const presenceRate = totalSessions > 0 ? Math.round((presentSessions / totalSessions) * 100) : 0;

  builder.definitionList([
    { label: 'Professeur', value: payload.teacher.name },
    { label: 'Période', value: coverage },
    { label: 'Séances', value: String(totalSessions) },
    { label: 'Taux de présence', value: `${presenceRate} %` },
  ]);
  builder.space(8);

  builder.kpiRow([
    { label: 'Séances', value: String(totalSessions), accent: t.color.brand },
    {
      label: 'Présences',
      value: `${presentSessions} / ${totalSessions}`,
      accent: t.color.success,
      valueColor: t.color.success,
    },
    {
      label: 'Retards',
      value: String(lateSessions),
      accent: t.color.warning,
      valueColor: lateSessions > 0 ? t.color.warning : undefined,
    },
    { label: 'Taux présence', value: `${presenceRate} %` },
  ]);
  builder.space(10);

  if (payload.rows.length === 0) {
    builder.paragraph('Aucune séance enregistrée sur cette période.', { color: t.color.muted });
  } else {
    builder.table({
      title: 'Détail des séances',
      columns: [
        { header: 'Date', width: COLUMN_WIDTHS.date },
        { header: 'Créneau', width: COLUMN_WIDTHS.slot },
        { header: 'Matière / Classe', width: COLUMN_WIDTHS.subject },
        { header: 'Salle', width: COLUMN_WIDTHS.room },
        { header: 'Présence', width: COLUMN_WIDTHS.status, align: 'center' },
        { header: 'Appel élèves', width: COLUMN_WIDTHS.rollcall, align: 'center' },
      ],
      rows: payload.rows.map((row) => [
        { text: formatDate(row.date) },
        { text: slotLabel(row.startTime, row.endTime) },
        { text: `${row.subject} · ${row.className}` },
        { text: row.roomName || '-' },
        {
          text: row.attendanceStatus
            ? formatAttendanceStatus(row.attendanceStatus, row.lateMinutes)
            : 'Non pointé',
          pill: attendanceStatusPill(row.attendanceStatus ?? 'not_marked', t),
        },
        {
          text: row.rollcallDone
            ? `${row.studentPresentCount}/${row.studentTotalCount}`
            : 'Non fait',
          align: 'center',
          color: row.rollcallDone ? t.color.ink : t.color.muted,
        },
      ]),
    });
  }

  builder.signatureBlock();
  return builder.save();
};
