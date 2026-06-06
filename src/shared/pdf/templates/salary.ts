import { PdfBuilder, type DocumentBranding } from '../builder.js';
import {
  attendanceStatusPill,
  formatAttendanceStatus,
  formatCompensation,
  formatDate,
  formatFcfa,
  formatHours,
  formatMonthLabel,
  formatPeriodCoverage,
  formatSalaryStatus,
  salaryStatusPill,
  teacherTypeLabel,
} from '../format.js';

/**
 * Payloads issus de BillingService - typés en `structural` pour éviter un
 * import croisé de module (cf. AGENTS.md : pas d'import entre modules). On ne
 * dépend que de la forme des données, pas du module billing.
 */
export type TeacherSalaryDetails = {
  month: string;
  teacher: {
    id: string;
    name: string;
    type: 'vacataire' | 'permanent' | string;
    hourlyRate: number | null;
    monthlySalary: number | null;
  };
  summary: {
    hoursPlanned: number;
    hoursDone: number;
    totalFcfa: number | null;
    status: string;
    absenceHours?: number | null;
    amountAlreadyPaid?: number | null;
    amountRemainingToPayNow?: number | null;
  };
  payment: {
    paidAt: string | null;
    paidByName: string | null;
    notes: string | null;
  };
  rows: Array<{
    date: string;
    slotLabel: string;
    subject: string;
    className: string;
    attendanceStatus: string;
    lateMinutes: number | null;
    hoursDone: number;
  }>;
};

export type SchoolSalarySummary = {
  month: string;
  items: Array<{
    teacherName: string;
    teacherType: 'vacataire' | 'permanent' | string;
    hoursPlanned: number;
    hoursDone: number;
    totalFcfa: number | null;
    amountAlreadyPaid: number;
    status: string;
  }>;
};

const COLUMN_WIDTHS = {
  date: 70,
  slot: 78,
  subject: 130,
  status: 96,
  hours: 56,
};

/**
 * Bilan de salaire d'un professeur pour un mois : carte d'identité, KPIs,
 * détail jour par jour, bloc signature.
 */
export const renderTeacherSalaryBilan = async (
  branding: DocumentBranding,
  details: TeacherSalaryDetails
): Promise<Uint8Array> => {
  const builder = await PdfBuilder.create(branding, {
    title: 'Bilan de salaire',
    subtitle: `${details.teacher.name} · ${formatMonthLabel(details.month)}`,
  });

  drawTeacherSection(builder, details, { showHeaderMonth: false });
  builder.signatureBlock();
  return builder.save();
};

/**
 * Bilan multi-période d'un professeur : un encart de section par mois.
 */
export const renderTeacherMultiPeriodBilan = async (
  branding: DocumentBranding,
  periodFrom: string,
  periodTo: string,
  monthly: TeacherSalaryDetails[]
): Promise<Uint8Array> => {
  const teacherName = monthly[0]?.teacher.name ?? 'Professeur';
  const builder = await PdfBuilder.create(branding, {
    title: 'Bilan de salaire',
    subtitle: `${teacherName} · ${formatPeriodCoverage(periodFrom, periodTo)}`,
  });

  // Récapitulatif cumulé en tête.
  const totalDone = monthly.reduce((s, m) => s + m.summary.hoursDone, 0);
  const totalFcfa = monthly.reduce((s, m) => s + (m.summary.totalFcfa ?? 0), 0);
  const totalPaid = monthly.reduce((s, m) => s + (m.summary.amountAlreadyPaid ?? 0), 0);

  builder.kpiRow([
    { label: 'Période', value: `${monthly.length} mois` },
    { label: 'Heures faites', value: formatHours(totalDone) },
    { label: 'Total période', value: formatFcfa(totalFcfa) },
    {
      label: 'Déjà payé',
      value: formatFcfa(totalPaid),
      accent: builder.t.color.success,
      valueColor: builder.t.color.success,
    },
  ]);
  builder.space(10);

  monthly.forEach((details, idx) => {
    if (idx > 0) builder.space(8);
    builder.sectionTitle(formatMonthLabel(details.month));
    drawTeacherSection(builder, details, { showHeaderMonth: true, compact: true });
  });

  builder.signatureBlock();
  return builder.save();
};

const drawTeacherSection = (
  builder: PdfBuilder,
  details: TeacherSalaryDetails,
  opts: { showHeaderMonth: boolean; compact?: boolean }
): void => {
  const t = builder.t;
  const { teacher, summary, payment } = details;

  // Carte d'identité.
  builder.definitionList([
    { label: 'Professeur', value: teacher.name },
    { label: 'Statut', value: teacherTypeLabel(teacher.type) },
    {
      label: 'Rémunération',
      value: formatCompensation(teacher.type, teacher.hourlyRate, teacher.monthlySalary),
    },
    { label: 'Période', value: formatMonthLabel(details.month) },
  ]);
  builder.space(8);

  // KPIs financiers.
  const statusColor =
    summary.status === 'paid'
      ? t.color.success
      : summary.status === 'disputed'
        ? t.color.danger
        : t.color.warning;
  const netToPay = Math.max(0, summary.amountRemainingToPayNow ?? 0);
  builder.kpiRow([
    { label: 'Heures prévues', value: formatHours(summary.hoursPlanned) },
    { label: 'Heures faites', value: formatHours(summary.hoursDone) },
    { label: 'Montant total', value: formatFcfa(summary.totalFcfa), accent: t.color.brand },
    {
      label: summary.status === 'paid' ? 'Statut' : 'Reste à payer',
      value: summary.status === 'paid' ? formatSalaryStatus(summary.status) : formatFcfa(netToPay),
      accent: statusColor,
      valueColor: statusColor,
    },
  ]);
  builder.space(6);

  if (payment.paidAt) {
    builder.paragraph(
      `Dernier paiement le ${formatDate(payment.paidAt)}${payment.paidByName ? ` par ${payment.paidByName}` : ''}.${payment.notes ? ` Note : ${payment.notes}` : ''}`,
      { size: t.size.small }
    );
    builder.space(4);
  }

  // Détail jour par jour.
  if (details.rows.length === 0) {
    builder.paragraph('Aucune séance enregistrée pour cette période.', {
      color: t.color.muted,
    });
    return;
  }

  builder.table({
    title: 'Détail des séances',
    columns: [
      { header: 'Date', width: COLUMN_WIDTHS.date },
      { header: 'Créneau', width: COLUMN_WIDTHS.slot },
      { header: 'Matière / Classe', width: COLUMN_WIDTHS.subject },
      { header: 'Présence', width: COLUMN_WIDTHS.status, align: 'center' },
      { header: 'Heures', width: COLUMN_WIDTHS.hours, align: 'right' },
    ],
    rows: details.rows.map((row) => [
      { text: formatDate(row.date) },
      { text: row.slotLabel },
      { text: `${row.subject} · ${row.className}` },
      {
        text: formatAttendanceStatus(row.attendanceStatus, row.lateMinutes),
        pill: attendanceStatusPill(row.attendanceStatus, t),
      },
      { text: formatHours(row.hoursDone), align: 'right', font: builder.f.medium },
    ]),
  });

  if (!opts.compact) {
    builder.totalBanner(
      summary.status === 'paid' ? 'Total payé' : 'Net à payer',
      formatFcfa(summary.status === 'paid' ? summary.totalFcfa : netToPay),
      { accent: statusColor }
    );
  }
};

/**
 * Bilan global des salaires de l'école pour un mois : tableau de tous les profs
 * + bandeau de masse salariale.
 */
export const renderSchoolSalaryBilan = async (
  branding: DocumentBranding,
  summary: SchoolSalarySummary
): Promise<Uint8Array> => {
  const builder = await PdfBuilder.create(branding, {
    title: 'Bilan des salaires',
    subtitle: formatMonthLabel(summary.month),
  });
  const t = builder.t;

  const totalPayroll = summary.items.reduce((s, i) => s + (i.totalFcfa ?? 0), 0);
  const totalPaid = summary.items.reduce((s, i) => s + i.amountAlreadyPaid, 0);
  const totalRemaining = summary.items.reduce((s, i) => {
    if (i.status === 'paid' || i.status === 'nothing_to_pay') return s;
    return s + Math.max(0, (i.totalFcfa ?? 0) - i.amountAlreadyPaid);
  }, 0);

  builder.kpiRow([
    { label: 'Professeurs', value: String(summary.items.length) },
    { label: 'Masse salariale', value: formatFcfa(totalPayroll), accent: t.color.brand },
    {
      label: 'Déjà payé',
      value: formatFcfa(totalPaid),
      accent: t.color.success,
      valueColor: t.color.success,
    },
    {
      label: 'Reste à payer',
      value: formatFcfa(totalRemaining),
      accent: t.color.warning,
      valueColor: t.color.warning,
    },
  ]);
  builder.space(10);

  if (summary.items.length === 0) {
    builder.paragraph('Aucun professeur à rémunérer pour ce mois.', { color: t.color.muted });
  } else {
    builder.table({
      title: 'Récapitulatif par professeur',
      columns: [
        { header: 'Professeur', width: 150 },
        { header: 'Type', width: 70 },
        { header: 'H. prévues', width: 62, align: 'right' },
        { header: 'H. faites', width: 56, align: 'right' },
        { header: 'Total', width: 78, align: 'right' },
        { header: 'Statut', width: 95, align: 'center' },
      ],
      rows: summary.items.map((item) => [
        { text: item.teacherName, font: builder.f.medium },
        { text: teacherTypeLabel(item.teacherType) },
        { text: formatHours(item.hoursPlanned), align: 'right' },
        { text: formatHours(item.hoursDone), align: 'right' },
        { text: formatFcfa(item.totalFcfa), align: 'right', font: builder.f.semibold },
        {
          text: formatSalaryStatus(item.status),
          pill: salaryStatusPill(item.status, t),
        },
      ]),
    });
    builder.totalBanner('Masse salariale du mois', formatFcfa(totalPayroll));
  }

  builder.signatureBlock();
  return builder.save();
};
