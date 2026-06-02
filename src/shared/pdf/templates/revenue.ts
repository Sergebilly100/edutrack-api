import { PdfBuilder, type DocumentBranding } from '../builder.js';
import { formatFcfa, formatMonthLabel, formatPeriodCoverage } from '../format.js';

/**
 * Ligne mensuelle du bilan des reversements (forme structurelle issue de
 * `subscriptionsService.getRevenueHistory`, pas d'import croisé de module).
 */
export type RevenueRow = {
  month: string;
  subscriptionsNewThisMonth: number;
  subscriptionsActiveCount: number;
  totalCollectedFcfa: number;
  commissionDueFcfa: number;
  commissionPaidFcfa: number;
  commissionRemainingFcfa: number;
  paymentStatus: string;
};

export type RevenuePayload = {
  periodFrom: string;
  periodTo: string;
  rows: RevenueRow[];
};

const COLUMN_WIDTHS = {
  month: 86,
  newSubs: 56,
  active: 52,
  collected: 84,
  due: 80,
  paid: 80,
  remaining: 80,
};

/**
 * Bilan des reversements d'abonnements sur une période : KPIs (encaissé,
 * commission due / versée / reste) + détail mensuel.
 * Remplace l'ancienne impression HTML navigateur.
 */
export const renderRevenueReport = async (
  branding: DocumentBranding,
  payload: RevenuePayload
): Promise<Uint8Array> => {
  const coverage = formatPeriodCoverage(payload.periodFrom, payload.periodTo);
  const builder = await PdfBuilder.create(branding, {
    title: 'Bilan des reversements',
    subtitle: coverage,
  });
  const t = builder.t;

  // Tri chronologique ascendant pour une lecture naturelle.
  const rows = [...payload.rows].sort((a, b) => a.month.localeCompare(b.month));

  const totalCollected = rows.reduce((s, r) => s + r.totalCollectedFcfa, 0);
  const totalDue = rows.reduce((s, r) => s + r.commissionDueFcfa, 0);
  const totalPaid = rows.reduce((s, r) => s + r.commissionPaidFcfa, 0);
  const totalRemaining = rows.reduce((s, r) => s + r.commissionRemainingFcfa, 0);

  builder.kpiRow([
    { label: 'Total encaissé', value: formatFcfa(totalCollected), accent: t.color.brand },
    { label: 'Commission due', value: formatFcfa(totalDue) },
    {
      label: 'Versé',
      value: formatFcfa(totalPaid),
      accent: t.color.success,
      valueColor: t.color.success,
    },
    {
      label: 'Reste à verser',
      value: formatFcfa(totalRemaining),
      accent: t.color.warning,
      valueColor: totalRemaining > 0 ? t.color.warning : undefined,
    },
  ]);
  builder.space(10);

  if (rows.length === 0) {
    builder.paragraph('Aucun reversement sur cette période.', { color: t.color.muted });
  } else {
    builder.table({
      title: 'Détail mensuel',
      columns: [
        { header: 'Mois', width: COLUMN_WIDTHS.month },
        { header: 'Nouv.', width: COLUMN_WIDTHS.newSubs, align: 'right' },
        { header: 'Actifs', width: COLUMN_WIDTHS.active, align: 'right' },
        { header: 'Encaissé', width: COLUMN_WIDTHS.collected, align: 'right' },
        { header: 'Comm. due', width: COLUMN_WIDTHS.due, align: 'right' },
        { header: 'Versé', width: COLUMN_WIDTHS.paid, align: 'right' },
        { header: 'Reste', width: COLUMN_WIDTHS.remaining, align: 'right' },
      ],
      rows: rows.map((row) => [
        { text: formatMonthLabel(row.month), font: builder.f.medium },
        { text: String(row.subscriptionsNewThisMonth), align: 'right' },
        { text: String(row.subscriptionsActiveCount), align: 'right' },
        { text: formatFcfa(row.totalCollectedFcfa), align: 'right' },
        { text: formatFcfa(row.commissionDueFcfa), align: 'right' },
        {
          text: formatFcfa(row.commissionPaidFcfa),
          align: 'right',
          color: t.color.success,
        },
        {
          text: formatFcfa(row.commissionRemainingFcfa),
          align: 'right',
          font: builder.f.semibold,
          color: row.commissionRemainingFcfa > 0 ? t.color.warning : t.color.muted,
        },
      ]),
    });
    builder.totalBanner('Reste total à verser', formatFcfa(totalRemaining), {
      accent: totalRemaining > 0 ? t.color.warning : t.color.success,
    });
  }

  builder.signatureBlock();
  return builder.save();
};
