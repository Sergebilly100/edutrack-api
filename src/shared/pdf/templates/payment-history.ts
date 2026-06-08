import { PdfBuilder, type DocumentBranding } from '../builder.js';
import {
  formatDateTime,
  formatFcfa,
  formatHours,
  formatMonthLabel,
  formatPeriodCoverage,
  formatSalaryStatus,
  salaryStatusPill,
  teacherTypeLabel,
} from '../format.js';

export type PaymentHistoryItem = {
  month: string;
  amountFcfa: number;
  hoursPaid: number | null;
  status: string;
  paidAt: string | null;
  paidByName: string | null;
  notes: string | null;
};

export type PaymentHistoryPayload = {
  teacher: {
    name: string;
    type: 'vacataire' | 'permanent' | string;
  };
  /** Bornes de couverture, ex « 2026-01 » → « 2026-04 ». */
  periodFrom: string;
  periodTo: string;
  items: PaymentHistoryItem[];
};

/**
 * Historique des paiements d'un professeur sur une période donnée.
 * Remplace l'ancien export CSV : document imprimable avec période de couverture
 * en clair (ex. « Janvier – Avril 2026 ») et total versé.
 */
export const renderPaymentHistory = async (
  branding: DocumentBranding,
  payload: PaymentHistoryPayload
): Promise<Uint8Array> => {
  const coverage = formatPeriodCoverage(payload.periodFrom, payload.periodTo);
  const builder = await PdfBuilder.create(branding, {
    title: 'Historique des paiements',
    subtitle: `${payload.teacher.name} · ${coverage}`,
  });
  const t = builder.t;

  // Tri chronologique ascendant pour une lecture naturelle.
  const items = [...payload.items].sort((a, b) => a.month.localeCompare(b.month));

  const totalPaid = items.reduce((s, i) => s + (i.amountFcfa ?? 0), 0);
  const totalHours = items.reduce((s, i) => s + (i.hoursPaid ?? 0), 0);
  const paidCount = items.filter((i) => i.status === 'paid').length;

  builder.definitionList([
    { label: 'Professeur', value: payload.teacher.name },
    { label: 'Statut', value: teacherTypeLabel(payload.teacher.type) },
    { label: 'Période couverte', value: coverage },
    { label: 'Paiements', value: `${items.length} enregistrement(s)` },
  ]);
  builder.space(8);

  builder.kpiRow([
    { label: 'Total versé', value: formatFcfa(totalPaid), accent: t.color.success, valueColor: t.color.success },
    { label: 'Heures payées', value: formatHours(totalHours) },
    { label: 'Mois soldés', value: `${paidCount} / ${items.length}` },
  ]);
  builder.space(10);

  if (items.length === 0) {
    builder.paragraph('Aucun paiement enregistré sur cette période.', { color: t.color.muted });
  } else {
    builder.table({
      title: 'Détail des paiements',
      columns: [
        { header: 'Mois', width: 92 },
        { header: 'Montant', width: 86, align: 'right' },
        { header: 'Heures', width: 54, align: 'right' },
        { header: 'Statut', width: 88, align: 'center' },
        { header: 'Payé le', width: 110 },
        { header: 'Par', width: 81 },
      ],
      rows: items.map((item) => [
        { text: formatMonthLabel(item.month), font: builder.f.medium },
        { text: formatFcfa(item.amountFcfa), align: 'right', font: builder.f.semibold },
        { text: item.hoursPaid !== null ? formatHours(item.hoursPaid) : '-', align: 'right' },
        { text: formatSalaryStatus(item.status), pill: salaryStatusPill(item.status, t) },
        { text: item.paidAt ? formatDateTime(item.paidAt) : '-', color: t.color.muted },
        { text: item.paidByName ?? '-', color: t.color.muted },
      ]),
    });
    builder.totalBanner('Total versé sur la période', formatFcfa(totalPaid), {
      accent: t.color.success,
    });
  }

  builder.signatureBlock();
  return builder.save();
};
