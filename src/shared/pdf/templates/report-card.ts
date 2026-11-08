import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';

import type { DocumentBranding, LoadedLogo } from '../builder.js';
import { embedBulletinFonts, type BulletinFonts } from '../fonts.js';
import {
  EMPTY_VALUE,
  birthDateLabel,
  formatBulletinRank,
  formatCivilDate,
  formatCoefficient,
  formatDecimal,
  formatIssueDate,
  formatNationality,
  formatRepeater,
  formatSex,
  formatTeachersCell,
  formatText,
} from '../report-card-format.js';
import type { BulletinSeals } from '../school-seal.js';

/**
 * Bulletin scolaire : A4 portrait, noir / gris / blanc uniquement, sans graphique.
 * Gabarit autonome (n'utilise pas le bandeau bleu de PdfBuilder). Présentation seule :
 * aucune valeur n'est recalculée ici, tout vient du snapshot du bulletin.
 */

export type ReportCardLinePayload = {
  label: string;
  average: number;
  coefficient: number;
  rank: number | null;
  isConduct?: boolean;
  /** Professeurs déjà formatés (« M. Koffi A. »), deux premiers affichés. */
  teachers?: string[];
  /** Moyenne de la classe pour la matière : null/absent partout → colonne masquée. */
  classAverage?: number | null;
  /** Appréciation du professeur : absente partout → colonne masquée. */
  appreciation?: string | null;
};

export type ReportCardStudentIdentity = {
  matricule?: string | null;
  /** Date civile `YYYY-MM-DD`. */
  birthDate?: string | null;
  birthPlace?: string | null;
  sex?: string | null;
  /** Code pays ISO 3166-1 alpha-2. */
  nationality?: string | null;
  /** Inscription de l'année scolaire du bulletin. */
  isRepeating?: boolean | null;
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
  /** Renseigné uniquement sur le dernier bulletin de l'année scolaire (sinon null). */
  yearEndDecisionLabel: string | null;
  lines: ReportCardLinePayload[];
  student?: ReportCardStudentIdentity;
  schoolPhone?: string | null;
  /** Date d'édition (par défaut : maintenant). */
  issuedAt?: Date;
};

// ── Palette : gris uniquement (contrôlée par les tests) ────────────────────

const gray = (level: number): RGB => rgb(level, level, level);
export const REPORT_CARD_PALETTE = {
  ink: gray(0.08),
  black: gray(0),
  muted: gray(0.36),
  faint: gray(0.5),
  rule: gray(0.78),
  band: gray(0.95),
  white: gray(1),
} as const;
const C = REPORT_CARD_PALETTE;

// ── Modèle d'affichage (pur, testable) ─────────────────────────────────────

export type ColumnKey = 'subject' | 'coefficient' | 'average' | 'classAverage' | 'rank' | 'teacher' | 'appreciation';

const COLUMN_DEFS: Array<{ key: ColumnKey; header: string; weight: number; align: 'left' | 'right'; optional?: boolean }> = [
  { key: 'subject', header: 'Matière', weight: 18, align: 'left' },
  { key: 'coefficient', header: 'Coef.', weight: 8, align: 'right' },
  { key: 'average', header: 'Moyenne', weight: 10, align: 'right' },
  { key: 'classAverage', header: 'Moy. classe', weight: 12, align: 'right', optional: true },
  { key: 'rank', header: 'Rang', weight: 8, align: 'right' },
  { key: 'teacher', header: 'Professeur', weight: 19, align: 'left' },
  { key: 'appreciation', header: 'Appréciation', weight: 25, align: 'left', optional: true },
];

export type ReportCardView = {
  schoolName: string;
  schoolLine: string | null;
  periodLabel: string;
  schoolYear: string;
  identityTop: Array<{ label: string; value: string }>;
  identityBottom: Array<{ label: string; value: string }>;
  summary: Array<{ label: string; value: string }>;
  columns: Array<{ key: ColumnKey; header: string; align: 'left' | 'right'; weight: number }>;
  rows: Array<{ isConduct: boolean; italic: boolean; cells: Record<ColumnKey, string> }>;
  total: Record<ColumnKey, string>;
  issueDate: string;
  city: string | null;
  signatoryLabel: string;
  /** Décision de fin d'année (dernier bulletin de l'année uniquement), sinon null. */
  decisionLabel: string | null;
};

export const SIGNATORY_LABEL = "Le chef de l'établissement";

export const buildReportCardView = (branding: DocumentBranding, payload: ReportCardPdfPayload): ReportCardView => {
  const student = payload.student ?? {};
  const city = branding.schoolMeta?.trim() || null;
  const phone = payload.schoolPhone?.trim() || null;
  const schoolLine = [city, phone ? `Tél. ${phone}` : null].filter(Boolean).join(' · ') || null;
  const showClassAverage = payload.lines.some((line) => typeof line.classAverage === 'number');
  const showAppreciation = payload.lines.some((line) => Boolean(line.appreciation?.trim()));

  const columns = COLUMN_DEFS.filter(
    (def) => !def.optional || (def.key === 'classAverage' ? showClassAverage : showAppreciation)
  ).map(({ key, header, align, weight }) => ({ key, header, align, weight }));

  const rows = payload.lines.map((line) => ({
    isConduct: Boolean(line.isConduct),
    italic: Boolean(line.isConduct) && line.coefficient > 0,
    cells: {
      subject: line.isConduct ? 'Conduite' : formatText(line.label),
      coefficient: formatCoefficient(line.coefficient),
      average: formatDecimal(line.average),
      classAverage: formatDecimal(line.classAverage),
      rank: formatBulletinRank(line.rank),
      teacher: line.isConduct ? 'Vie scolaire' : formatTeachersCell(line.teachers ?? []),
      appreciation: formatText(line.appreciation),
    } satisfies Record<ColumnKey, string>,
  }));

  const totalCoefficient = payload.lines.reduce((sum, line) => sum + line.coefficient, 0);
  const headcount = payload.classHeadcount > 0 ? payload.classHeadcount : null;
  const rankLabel = formatBulletinRank(payload.generalRank);

  return {
    schoolName: branding.schoolName,
    schoolLine,
    periodLabel: payload.periodLabel,
    schoolYear: `Année scolaire ${payload.schoolYearLabel}`,
    identityTop: [
      { label: 'Élève', value: formatText(payload.studentName) },
      { label: 'Matricule', value: formatText(student.matricule) },
      { label: 'Classe', value: formatText(payload.className) },
      { label: 'Effectif', value: headcount === null ? EMPTY_VALUE : `${headcount} élève${headcount > 1 ? 's' : ''}` },
    ],
    identityBottom: [
      { label: birthDateLabel(student.sex), value: formatCivilDate(student.birthDate) },
      { label: 'Lieu de naissance', value: formatText(student.birthPlace) },
      { label: 'Sexe', value: formatSex(student.sex) },
      { label: 'Nationalité', value: formatNationality(student.nationality, student.sex) },
      { label: 'Redoublant', value: formatRepeater(student.isRepeating) },
    ],
    summary: [
      { label: 'Moyenne générale', value: `${formatDecimal(payload.generalAverage)} / 20` },
      { label: 'Rang', value: rankLabel === EMPTY_VALUE ? EMPTY_VALUE : headcount ? `${rankLabel} / ${headcount}` : rankLabel },
      { label: 'Moyenne de la classe', value: formatDecimal(payload.classAverage) },
      { label: 'Plus forte moyenne', value: formatDecimal(payload.classMaxAverage) },
      { label: 'Plus faible moyenne', value: formatDecimal(payload.classMinAverage) },
    ],
    columns,
    rows,
    total: {
      subject: 'Total',
      coefficient: formatCoefficient(totalCoefficient),
      average: formatDecimal(payload.generalAverage),
      classAverage: formatDecimal(payload.classAverage),
      rank: rankLabel,
      teacher: '',
      appreciation: '',
    },
    issueDate: formatIssueDate(payload.issuedAt ?? new Date()),
    city,
    signatoryLabel: SIGNATORY_LABEL,
    decisionLabel: payload.yearEndDecisionLabel?.trim() || null,
  };
};

// ── Rendu ──────────────────────────────────────────────────────────────────

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const CONTENT_W = PAGE.width - MARGIN * 2;
const FOOTER_RULE_TOP = PAGE.height - 50;
const CONTENT_BOTTOM_TOP = FOOTER_RULE_TOP - 10;
const HEADER_ROW_H = 22;
const MIN_ROW_H = 20;
const MAX_ROW_H = 27;
const TOTAL_ROW_H = 26;
const SEAL_BOX_H = 100;
const SEAL_BOX_W = Math.round(CONTENT_W * 0.46);
const SIGNATORY_GAP = 24;
const TAIL_H = TOTAL_ROW_H + SIGNATORY_GAP + 14 + 14 + SEAL_BOX_H;
const CELL_PAD = 8;
const LINE_H = 11;

type Logger = { warn: (msg: string, meta?: Record<string, unknown>) => void };

type Ctx = {
  pdf: PDFDocument;
  fonts: BulletinFonts;
  pages: PDFPage[];
  page: PDFPage;
};

const widthOf = (font: PDFFont, text: string, size: number): number => font.widthOfTextAtSize(text, size);

const truncate = (font: PDFFont, text: string, size: number, maxWidth: number): string => {
  if (widthOf(font, text, size) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && widthOf(font, `${result}…`, size) > maxWidth) result = result.slice(0, -1);
  return `${result.trimEnd()}…`;
};

/** Retour à la ligne par mots ; au-delà de maxLines, la dernière ligne est tronquée proprement. */
const wrapLines = (font: PDFFont, text: string, size: number, maxWidth: number, maxLines: number): string[] => {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (widthOf(font, candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length === 0) return [''];
  const kept = lines.slice(0, maxLines);
  if (lines.length > maxLines) kept[maxLines - 1] = truncate(font, `${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, size, maxWidth);
  return kept.map((line) => truncate(font, line, size, maxWidth));
};

const text = (
  ctx: Ctx,
  value: string,
  x: number,
  baselineTop: number,
  opts: { font: PDFFont; size: number; color?: RGB; align?: 'left' | 'right' | 'center'; width?: number }
): void => {
  let drawX = x;
  const w = widthOf(opts.font, value, opts.size);
  if (opts.align === 'right') drawX = x + (opts.width ?? 0) - w;
  if (opts.align === 'center') drawX = x + ((opts.width ?? 0) - w) / 2;
  ctx.page.drawText(value, { x: drawX, y: PAGE.height - baselineTop, size: opts.size, font: opts.font, color: opts.color ?? C.ink });
};

const hLine = (ctx: Ctx, top: number, thickness: number, color: RGB, x1 = MARGIN, x2 = PAGE.width - MARGIN): void => {
  ctx.page.drawLine({ start: { x: x1, y: PAGE.height - top }, end: { x: x2, y: PAGE.height - top }, thickness, color });
};

const vLine = (ctx: Ctx, x: number, top: number, bottom: number, color: RGB): void => {
  ctx.page.drawLine({ start: { x, y: PAGE.height - top }, end: { x, y: PAGE.height - bottom }, thickness: 0.6, color });
};

const box = (ctx: Ctx, x: number, top: number, width: number, height: number, opts: { fill?: RGB; border?: RGB }): void => {
  ctx.page.drawRectangle({
    x,
    y: PAGE.height - top - height,
    width,
    height,
    ...(opts.fill ? { color: opts.fill } : {}),
    ...(opts.border ? { borderColor: opts.border, borderWidth: 0.8 } : {}),
  });
};

const caption = (ctx: Ctx, label: string, x: number, baselineTop: number, align?: 'left' | 'right', width?: number): void =>
  text(ctx, truncate(ctx.fonts.semibold, label.toUpperCase(), 6.8, width ?? 120), x, baselineTop, { font: ctx.fonts.semibold, size: 6.8, color: C.muted, align, width });

const initialsOf = (name: string): string => {
  const words = name.replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'É';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
};

const embedImage = async (pdf: PDFDocument, image: LoadedLogo | null | undefined, kind: string, logger?: Logger): Promise<PDFImage | null> => {
  if (!image) return null;
  try {
    return image.format === 'png' ? await pdf.embedPng(image.bytes) : await pdf.embedJpg(image.bytes);
  } catch {
    // Une image illisible ne fait jamais échouer le bulletin ; aucune donnée personnelle journalisée.
    logger?.warn('[pdf] Unable to embed bulletin image', { kind });
    return null;
  }
};

const drawImageFit = (ctx: Ctx, image: PDFImage, x: number, top: number, maxW: number, maxH: number): void => {
  const scaled = image.scaleToFit(maxW, maxH);
  ctx.page.drawImage(image, {
    x: x + (maxW - scaled.width) / 2,
    y: PAGE.height - top - maxH + (maxH - scaled.height) / 2,
    width: scaled.width,
    height: scaled.height,
  });
};

const drawFirstHeader = (ctx: Ctx, view: ReportCardView, logo: PDFImage | null): number => {
  const top = MARGIN;
  const logoSize = 56;
  if (logo) {
    drawImageFit(ctx, logo, MARGIN, top, logoSize, logoSize);
  } else {
    ctx.page.drawCircle({ x: MARGIN + logoSize / 2, y: PAGE.height - top - logoSize / 2, size: logoSize / 2 - 1, borderColor: C.ink, borderWidth: 1.2 });
    text(ctx, initialsOf(view.schoolName), MARGIN, top + logoSize / 2 + 6, { font: ctx.fonts.serifBold, size: 17, align: 'center', width: logoSize });
  }

  const leftX = MARGIN + logoSize + 14;
  const leftW = CONTENT_W * 0.6 - logoSize - 14;
  let nameSize = 16;
  let nameLines = wrapLines(ctx.fonts.serifBold, view.schoolName, nameSize, leftW, 2);
  if (nameLines.length > 1) {
    nameSize = 13;
    nameLines = wrapLines(ctx.fonts.serifBold, view.schoolName, nameSize, leftW, 2);
  }
  let baseline = top + (nameLines.length > 1 ? 16 : 26);
  for (const line of nameLines) {
    text(ctx, line, leftX, baseline, { font: ctx.fonts.serifBold, size: nameSize });
    baseline += nameSize + 2;
  }
  if (view.schoolLine) {
    text(ctx, truncate(ctx.fonts.regular, view.schoolLine, 9.5, leftW), leftX, baseline + 4, { font: ctx.fonts.regular, size: 9.5, color: C.muted });
  }

  const rightW = CONTENT_W * 0.4;
  const rightX = PAGE.width - MARGIN - rightW;
  text(ctx, 'BULLETIN SCOLAIRE', rightX, top + 10, { font: ctx.fonts.semibold, size: 9, color: C.muted, align: 'right', width: rightW });
  let periodSize = 19;
  while (periodSize > 14 && widthOf(ctx.fonts.serifBold, view.periodLabel, periodSize) > rightW) periodSize -= 1;
  text(ctx, truncate(ctx.fonts.serifBold, view.periodLabel, periodSize, rightW), rightX, top + 10 + periodSize + 2, {
    font: ctx.fonts.serifBold, size: periodSize, align: 'right', width: rightW,
  });
  text(ctx, truncate(ctx.fonts.regular, view.schoolYear, 9.5, rightW), rightX, top + 10 + periodSize + 18, {
    font: ctx.fonts.regular, size: 9.5, color: C.muted, align: 'right', width: rightW,
  });

  const ruleTop = top + logoSize + 16;
  hLine(ctx, ruleTop, 2.4, C.black);
  hLine(ctx, ruleTop + 4.5, 0.8, C.black);
  return ruleTop + 4.5;
};

const drawContinuationHeader = (ctx: Ctx, view: ReportCardView, studentName: string): number => {
  const top = MARGIN;
  text(ctx, truncate(ctx.fonts.serifBold, view.schoolName, 12, CONTENT_W * 0.5), MARGIN, top + 12, { font: ctx.fonts.serifBold, size: 12 });
  const right = `Bulletin scolaire · ${view.periodLabel} · ${studentName}`;
  text(ctx, truncate(ctx.fonts.regular, right, 8.5, CONTENT_W * 0.5), PAGE.width - MARGIN - CONTENT_W * 0.5, top + 12, {
    font: ctx.fonts.regular, size: 8.5, color: C.muted, align: 'right', width: CONTENT_W * 0.5,
  });
  hLine(ctx, top + 20, 2, C.black);
  return top + 20;
};

const drawIdentity = (ctx: Ctx, view: ReportCardView, top: number): number => {
  const height = 96;
  box(ctx, MARGIN, top, CONTENT_W, height, { border: C.muted });
  const inner = CONTENT_W - CELL_PAD * 4;
  const x0 = MARGIN + CELL_PAD * 2;
  const topX = [0, 0.44, 0.62, 0.81].map((f) => x0 + inner * f);
  const bottomX = [0, 0.2, 0.44, 0.62, 0.81].map((f) => x0 + inner * f);
  const widthAt = (xs: number[], i: number): number => (xs[i + 1] ?? x0 + inner) - xs[i]! - 8;

  view.identityTop.forEach((cell, i) => {
    caption(ctx, cell.label, topX[i]!, top + 15, 'left', widthAt(topX, i));
    if (i === 0) {
      let size = 15;
      while (size > 10.5 && widthOf(ctx.fonts.serifBold, cell.value, size) > widthAt(topX, i)) size -= 0.5;
      wrapLines(ctx.fonts.serifBold, cell.value, size, widthAt(topX, i), 2).forEach((line, n) =>
        text(ctx, line, topX[i]!, top + 34 + n * (size + 1), { font: ctx.fonts.serifBold, size })
      );
    } else {
      wrapLines(ctx.fonts.semibold, cell.value, 10, widthAt(topX, i), 2).forEach((line, n) =>
        text(ctx, line, topX[i]!, top + 34 + n * LINE_H, { font: ctx.fonts.semibold, size: 10 })
      );
    }
  });
  hLine(ctx, top + 48, 0.6, C.rule, MARGIN + CELL_PAD * 2, PAGE.width - MARGIN - CELL_PAD * 2);
  view.identityBottom.forEach((cell, i) => {
    caption(ctx, cell.label, bottomX[i]!, top + 63, 'left', widthAt(bottomX, i));
    wrapLines(ctx.fonts.semibold, cell.value, 10, widthAt(bottomX, i), 2).forEach((line, n) =>
      text(ctx, line, bottomX[i]!, top + 81 + n * LINE_H, { font: ctx.fonts.semibold, size: 10 })
    );
  });
  return top + height;
};

const drawSummary = (ctx: Ctx, view: ReportCardView, top: number): number => {
  const height = 40;
  box(ctx, MARGIN, top, CONTENT_W, height, { fill: C.band, border: C.rule });
  const fractions = [0.24, 0.14, 0.22, 0.2, 0.2];
  let x = MARGIN;
  view.summary.forEach((cell, i) => {
    const w = CONTENT_W * fractions[i]!;
    if (i > 0) vLine(ctx, x, top + 8, top + height - 8, C.rule);
    caption(ctx, cell.label, x + 12, top + 15, 'left', w - 16);
    const strong = i < 2;
    text(ctx, truncate(strong ? ctx.fonts.bold : ctx.fonts.regular, cell.value, strong ? 13 : 11, w - 16), x + 12, top + 31, {
      font: strong ? ctx.fonts.bold : ctx.fonts.regular, size: strong ? 13 : 11,
    });
    x += w;
  });
  return top + height;
};

type PlacedColumn = { key: ColumnKey; header: string; align: 'left' | 'right'; x: number; width: number };

export const layoutReportCardColumns = (view: Pick<ReportCardView, 'columns'>): PlacedColumn[] => {
  const totalWeight = view.columns.reduce((sum, col) => sum + col.weight, 0);
  let x = MARGIN;
  return view.columns.map((col) => {
    const width = (CONTENT_W * col.weight) / totalWeight;
    const placed = { key: col.key, header: col.header, align: col.align, x, width };
    x += width;
    return placed;
  });
};

const drawColumnHeader = (ctx: Ctx, columns: PlacedColumn[], top: number): number => {
  box(ctx, MARGIN, top, CONTENT_W, HEADER_ROW_H, { fill: C.band });
  for (const col of columns) {
    caption(ctx, col.header, col.x + CELL_PAD, top + 14, col.align, col.width - CELL_PAD * 2);
  }
  return top + HEADER_ROW_H;
};

const cellFont = (fonts: BulletinFonts, key: ColumnKey, italic: boolean): { font: PDFFont; size: number; color: RGB } => {
  if (italic) {
    return key === 'subject'
      ? { font: fonts.mediumItalic, size: 10, color: C.ink }
      : { font: fonts.italic, size: key === 'teacher' || key === 'appreciation' ? 9 : 10, color: key === 'average' ? C.ink : C.muted };
  }
  switch (key) {
    case 'subject': return { font: fonts.bold, size: 10, color: C.ink };
    case 'average': return { font: fonts.bold, size: 10, color: C.ink };
    case 'rank': return { font: fonts.medium, size: 10, color: C.ink };
    case 'teacher': return { font: fonts.regular, size: 9, color: C.muted };
    case 'appreciation': return { font: fonts.italic, size: 9, color: C.muted };
    default: return { font: fonts.regular, size: 10, color: C.muted };
  }
};

const measureRows = (ctx: Ctx, view: ReportCardView, columns: PlacedColumn[]): Array<Array<string[]>> =>
  view.rows.map((row) =>
    columns.map((col) => {
      const style = cellFont(ctx.fonts, col.key, row.italic);
      const wrappable = col.key === 'subject' || col.key === 'teacher' || col.key === 'appreciation';
      return wrapLines(style.font, row.cells[col.key], style.size, col.width - CELL_PAD * 2, wrappable ? 2 : 1);
    })
  );

const drawRow = (ctx: Ctx, view: ReportCardView, columns: PlacedColumn[], rowIndex: number, lines: string[][], top: number, height: number): void => {
  const row = view.rows[rowIndex]!;
  // Filet plus marqué au-dessus de la conduite pour la séparer des matières.
  if (row.isConduct && rowIndex > 0) hLine(ctx, top, 1.1, C.muted);
  columns.forEach((col, i) => {
    const style = cellFont(ctx.fonts, col.key, row.italic);
    const cellLines = lines[i]!;
    const blockH = cellLines.length * LINE_H;
    let baseline = top + (height - blockH) / 2 + LINE_H - 2.5;
    for (const line of cellLines) {
      text(ctx, line, col.x + CELL_PAD, baseline, { ...style, align: col.align, width: col.width - CELL_PAD * 2 });
      baseline += LINE_H;
    }
  });
  hLine(ctx, top + height, 0.5, C.rule);
};

const drawTotal = (ctx: Ctx, view: ReportCardView, columns: PlacedColumn[], top: number): number => {
  box(ctx, MARGIN, top, CONTENT_W, TOTAL_ROW_H, { fill: C.band });
  hLine(ctx, top, 1.2, C.black);
  hLine(ctx, top + TOTAL_ROW_H, 1.6, C.black);
  for (const col of columns) {
    const value = view.total[col.key];
    if (!value) continue;
    const bold = col.key === 'subject' || col.key === 'coefficient' || col.key === 'average' || col.key === 'rank';
    text(ctx, value, col.x + CELL_PAD, top + 17, {
      font: bold ? ctx.fonts.bold : ctx.fonts.regular, size: 10, color: bold ? C.ink : C.muted, align: col.align, width: col.width - CELL_PAD * 2,
    });
  }
  return top + TOTAL_ROW_H;
};

const drawSignatory = async (ctx: Ctx, view: ReportCardView, seals: BulletinSeals | null, top: number, logger?: Logger): Promise<void> => {
  const right = PAGE.width - MARGIN;
  text(ctx, view.city ? `Fait à ${view.city}, le ${view.issueDate}` : `Fait le ${view.issueDate}`, MARGIN, top + 11, {
    font: ctx.fonts.regular, size: 9.5, color: C.muted, align: 'right', width: CONTENT_W,
  });
  const boxTop = top + 14 + 14;
  const boxX = right - SEAL_BOX_W;
  // Décision de fin d'année : uniquement présente sur le dernier bulletin de l'année scolaire.
  if (view.decisionLabel) {
    const decisionW = Math.round(CONTENT_W * 0.36);
    box(ctx, MARGIN, boxTop, decisionW, 44, { fill: C.band, border: C.rule });
    caption(ctx, 'Décision de fin d\u2019année', MARGIN + 12, boxTop + 17, 'left', decisionW - 24);
    text(ctx, truncate(ctx.fonts.bold, view.decisionLabel, 13, decisionW - 24), MARGIN + 12, boxTop + 35, { font: ctx.fonts.bold, size: 13 });
  }
  // Case sans cadre, libellé aligné à droite.
  text(ctx, view.signatoryLabel, boxX, boxTop + 10, { font: ctx.fonts.semibold, size: 9, color: C.muted, align: 'right', width: SEAL_BOX_W });

  const areaX = boxX + 10;
  const areaTop = boxTop + 20;
  const areaW = SEAL_BOX_W - 20;
  const areaH = SEAL_BOX_H - 24;
  // Image unique ; repli : anciennes images (cachet à gauche, signature à droite) ; sinon case vide.
  const unified = await embedImage(ctx.pdf, seals?.unified, 'seal', logger);
  if (unified) {
    drawImageFit(ctx, unified, areaX, areaTop, areaW, areaH);
    return;
  }
  const stamp = await embedImage(ctx.pdf, seals?.legacy.stamp, 'stamp', logger);
  const signature = await embedImage(ctx.pdf, seals?.legacy.signature, 'signature', logger);
  const present = [stamp, signature].filter((image): image is PDFImage => image !== null);
  present.forEach((image, i) => {
    const slotW = areaW / present.length;
    drawImageFit(ctx, image, areaX + i * slotW, areaTop, slotW - (present.length > 1 ? 6 : 0), areaH);
  });
};

const drawPageFooters = (ctx: Ctx, issueDate: string): void => {
  const total = ctx.pages.length;
  ctx.pages.forEach((page, index) => {
    ctx.page = page;
    hLine(ctx, FOOTER_RULE_TOP, 0.5, C.rule);
    text(ctx, `Bulletin édité le ${issueDate} · Document généré par IvoirEdu`, MARGIN, FOOTER_RULE_TOP + 16, {
      font: ctx.fonts.regular, size: 8, color: C.faint,
    });
    text(ctx, `Page ${index + 1} / ${total}`, MARGIN, FOOTER_RULE_TOP + 16, {
      font: ctx.fonts.regular, size: 8, color: C.faint, align: 'right', width: CONTENT_W,
    });
  });
};

export const renderReportCard = async (
  branding: DocumentBranding,
  payload: ReportCardPdfPayload,
  seals: BulletinSeals | null = null,
  deps: { logger?: Logger } = {}
): Promise<Uint8Array> => {
  const view = buildReportCardView(branding, payload);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Bulletin scolaire - ${branding.schoolName}`);
  pdf.setProducer('IvoirEdu');
  pdf.setCreator('IvoirEdu');
  const fonts = await embedBulletinFonts(pdf);
  const first = pdf.addPage([PAGE.width, PAGE.height]);
  const ctx: Ctx = { pdf, fonts, pages: [first], page: first };

  const logo = await embedImage(pdf, branding.logo, 'logo', deps.logger);
  let y = drawFirstHeader(ctx, view, logo) + 14;
  y = drawIdentity(ctx, view, y) + 10;
  y = drawSummary(ctx, view, y) + 14;

  const columns = layoutReportCardColumns(view);
  const measured = measureRows(ctx, view, columns);
  const needed = measured.map((cells) => Math.max(...cells.map((lines) => lines.length)) * LINE_H + 9);

  // Hauteur de ligne adaptée : jusqu'à 12 matières (+ conduite) sur une page ; au-delà, hauteur minimale et pagination.
  const count = view.rows.length;
  const firstPageSpace = CONTENT_BOTTOM_TOP - y - HEADER_ROW_H - TAIL_H;
  const baseHeight = count <= 13 ? Math.min(MAX_ROW_H, Math.max(MIN_ROW_H, Math.floor(firstPageSpace / Math.max(count, 1)))) : MIN_ROW_H;

  y = drawColumnHeader(ctx, columns, y);
  for (let i = 0; i < count; i += 1) {
    const height = Math.max(baseHeight, needed[i]!);
    const isLast = i === count - 1;
    if (y + height + (isLast ? TAIL_H : 0) > CONTENT_BOTTOM_TOP) {
      ctx.page = pdf.addPage([PAGE.width, PAGE.height]);
      ctx.pages.push(ctx.page);
      y = drawContinuationHeader(ctx, view, payload.studentName) + 14;
      y = drawColumnHeader(ctx, columns, y);
    }
    drawRow(ctx, view, columns, i, measured[i]!, y, height);
    y += height;
  }

  y = drawTotal(ctx, view, columns, y);
  await drawSignatory(ctx, view, seals, y + SIGNATORY_GAP, deps.logger);
  drawPageFooters(ctx, view.issueDate);
  return pdf.save();
};
