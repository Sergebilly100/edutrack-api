import { PdfBuilder, type DocumentBranding, type LoadedLogo } from '../builder.js';
import { formatDateTime } from '../format.js';

export type ReportCardLinePayload = {
  label: string;
  average: number;
  coefficient: number;
  rank: number | null;
  isConduct?: boolean;
};

export type ReportCardPdfPayload = {
  studentName: string;
  className: string;
  periodLabel: string;
  schoolYearLabel: string;
  generalAverage: number;
  generalRank: number;
  classHeadcount: number;
  classAverage: number;
  classMinAverage: number;
  classMaxAverage: number;
  yearEndDecisionLabel: string | null;
  lines: ReportCardLinePayload[];
};

export const renderReportCard = async (
  branding: DocumentBranding,
  payload: ReportCardPdfPayload,
  seals: { stamp?: LoadedLogo | null; signature?: LoadedLogo | null } = {}
): Promise<Uint8Array> => {
  const builder = await PdfBuilder.create(branding, {
    title: 'Bulletin scolaire',
    subtitle: `${payload.periodLabel} - ${payload.schoolYearLabel}`,
  });

  builder.definitionList([
    { label: 'Élève', value: payload.studentName },
    { label: 'Classe', value: payload.className },
    { label: 'Période', value: payload.periodLabel },
    { label: 'Année scolaire', value: payload.schoolYearLabel },
  ]);
  builder.space(10);

  builder.kpiRow([
    {
      label: 'Moyenne générale',
      value: `${payload.generalAverage.toFixed(2)}/20`,
    },
    {
      label: 'Rang',
      value: `${payload.generalRank} / ${payload.classHeadcount}`,
    },
  ]);

  builder.table({
    title: 'Détail par matière',
    columns: [
      { header: 'Matière', width: 220 },
      { header: 'Moyenne', width: 90, align: 'right' },
      { header: 'Coef.', width: 70, align: 'right' },
      { header: 'Rang', width: 121, align: 'right' },
    ],
    rows: payload.lines.map((line) => [
      {
        text: line.isConduct ? 'Conduite' : line.label,
        font: line.isConduct ? builder.f.medium : builder.f.regular,
      },
      { text: line.average.toFixed(2), font: builder.f.regular },
      { text: `×${line.coefficient.toFixed(2).replace(/\.00$/, '')}`, font: builder.f.regular },
      {
        text: line.rank !== null ? `${line.rank}${line.isConduct ? '' : 'e'}` : '-',
        font: builder.f.regular,
      },
    ]),
  });
  builder.space(8);

  builder.table({
    title: 'Statistiques de la classe (figées à la génération)',
    columns: [
      { header: 'Moyenne classe', width: 110, align: 'right' },
      { header: 'Plus forte', width: 110, align: 'right' },
      { header: 'Plus faible', width: 110, align: 'right' },
      { header: 'Effectif', width: 131, align: 'right' },
    ],
    rows: [
      [
        { text: payload.classAverage.toFixed(2), font: builder.f.semibold },
        { text: payload.classMaxAverage.toFixed(2), font: builder.f.regular },
        { text: payload.classMinAverage.toFixed(2), font: builder.f.regular },
        { text: String(payload.classHeadcount), font: builder.f.regular },
      ],
    ],
  });

  if (payload.yearEndDecisionLabel) {
    builder.space(10);
    builder.totalBanner('Décision de fin d\u2019année', payload.yearEndDecisionLabel);
  }

  builder.space(12);
  builder.paragraph(`Bulletin généré le ${formatDateTime(new Date().toISOString())}.`);
  await builder.stampAndSignature(seals);
  return builder.save();
};
