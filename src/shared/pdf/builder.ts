import { PDFDocument, rgb, type PDFImage, type PDFPage, type RGB, type PDFFont } from 'pdf-lib';

import { embedFonts, type PdfFonts } from './fonts.js';
import { buildTheme, type PdfTheme } from './theme.js';

/**
 * Logo déjà décodé (format + octets), tel que produit par le chargeur de branding.
 */
export type LoadedLogo = {
  bytes: Uint8Array;
  format: 'png' | 'jpg';
};

export type DocumentBranding = {
  schoolName: string;
  /** Sous-titre institutionnel : ville, type d'établissement, etc. */
  schoolMeta?: string | null;
  logo: LoadedLogo | null;
  /** Intitulé du signataire (Directeur / Proviseur / Principal…). */
  signatoryTitle?: string;
  /** Couleur de marque facultative (override du bleu par défaut). */
  brandColor?: RGB;
};

type TextOptions = {
  font?: PDFFont;
  size?: number;
  color?: RGB;
  /** Largeur max : tronque avec une ellipse si dépassée. */
  maxWidth?: number;
  align?: 'left' | 'center' | 'right';
  /** x de référence pour center/right (sinon align par rapport à maxWidth depuis x). */
  letterSpacing?: number;
};

export type TableColumn = {
  header: string;
  /** Largeur en points. La somme doit tenir dans la zone de contenu. */
  width: number;
  align?: 'left' | 'center' | 'right';
};

export type TableCell = {
  text: string;
  color?: RGB;
  font?: PDFFont;
  /** Rend la cellule comme une pastille de statut colorée. */
  pill?: { bg: RGB; fg: RGB };
};

export type TableOptions = {
  columns: TableColumn[];
  rows: TableCell[][];
  /** Titre de section au-dessus de la table. */
  title?: string;
  zebra?: boolean;
  rowHeight?: number;
};

const HEADER_BAND_HEIGHT = 96;
const FOOTER_HEIGHT = 64;

/**
 * Constructeur de PDF haut de gamme pour les bilans EduTrack.
 *
 * Gère la pagination automatique, l'en-tête de marque répété, le pied de page
 * avec numérotation et bloc signature, et fournit des primitives soignées
 * (cartes KPI, tables zébrées avec pastilles de statut).
 */
export class PdfBuilder {
  private pdf!: PDFDocument;
  private fonts!: PdfFonts;
  private theme: PdfTheme;
  private page!: PDFPage;
  private logoImage: PDFImage | null = null;
  private cursorY = 0;
  private pageNumber = 0;
  /** Métadonnées du document, dessinées dans l'en-tête de chaque page. */
  private title = '';
  private subtitle = '';

  private constructor(
    private readonly branding: DocumentBranding,
    private readonly meta: { title: string; subtitle: string }
  ) {
    this.theme = buildTheme(branding.brandColor);
    this.title = meta.title;
    this.subtitle = meta.subtitle;
  }

  static async create(
    branding: DocumentBranding,
    meta: { title: string; subtitle: string }
  ): Promise<PdfBuilder> {
    const builder = new PdfBuilder(branding, meta);
    builder.pdf = await PDFDocument.create();
    builder.pdf.setTitle(`${meta.title} — ${branding.schoolName}`);
    builder.pdf.setProducer('EduTrack CI');
    builder.pdf.setCreator('EduTrack CI');
    builder.fonts = await embedFonts(builder.pdf);

    if (branding.logo) {
      // Un logo corrompu ne doit jamais faire échouer (ni bloquer) un export :
      // en cas d'erreur de décodage, on retombe sur le cartouche d'initiales.
      try {
        builder.logoImage =
          branding.logo.format === 'png'
            ? await builder.pdf.embedPng(branding.logo.bytes)
            : await builder.pdf.embedJpg(branding.logo.bytes);
      } catch {
        builder.logoImage = null;
      }
    }

    builder.addPage();
    return builder;
  }

  get t(): PdfTheme {
    return this.theme;
  }

  get f(): PdfFonts {
    return this.fonts;
  }

  private get contentLeft(): number {
    return this.theme.size.pageMargin;
  }

  private get contentRight(): number {
    return this.theme.page.width - this.theme.size.pageMargin;
  }

  get contentWidth(): number {
    return this.contentRight - this.contentLeft;
  }

  /** Y le plus bas avant d'entrer dans la zone de pied de page. */
  private get contentBottom(): number {
    return FOOTER_HEIGHT;
  }

  // ── Mesure & rendu de texte ────────────────────────────────────────────

  private measure(text: string, font: PDFFont, size: number): number {
    return font.widthOfTextAtSize(text, size);
  }

  /** Tronque avec « … » pour tenir dans maxWidth. */
  private truncate(text: string, font: PDFFont, size: number, maxWidth: number): string {
    if (this.measure(text, font, size) <= maxWidth) {
      return text;
    }
    const ellipsis = '…';
    let result = text;
    while (result.length > 0 && this.measure(result + ellipsis, font, size) > maxWidth) {
      result = result.slice(0, -1);
    }
    return result.trimEnd() + ellipsis;
  }

  /** Découpe un texte en plusieurs lignes pour tenir dans maxWidth. */
  wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (this.measure(candidate, font, size) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  private drawText(page: PDFPage, x: number, y: number, text: string, opts: TextOptions): void {
    const font = opts.font ?? this.fonts.regular;
    const size = opts.size ?? this.theme.size.body;
    const color = opts.color ?? this.theme.color.ink;
    let value = text;
    if (opts.maxWidth) {
      value = this.truncate(value, font, size, opts.maxWidth);
    }
    let drawX = x;
    if (opts.align === 'center' || opts.align === 'right') {
      const width = this.measure(value, font, size);
      const box = opts.maxWidth ?? 0;
      if (opts.align === 'center') drawX = x + (box - width) / 2;
      if (opts.align === 'right') drawX = x + box - width;
    }
    page.drawText(value, {
      x: drawX,
      y,
      size,
      font,
      color,
      ...(opts.letterSpacing ? { wordBreaks: [] } : {}),
    });
  }

  // ── Pagination & chrome (header band + footer) ─────────────────────────

  private addPage(): void {
    this.pageNumber += 1;
    this.page = this.pdf.addPage([this.theme.page.width, this.theme.page.height]);
    this.drawHeaderBand();
    this.drawFooter();
    this.cursorY = this.theme.page.height - HEADER_BAND_HEIGHT - 28;
  }

  private drawHeaderBand(): void {
    const { color, size } = this.theme;
    const top = this.theme.page.height;

    // Bandeau de marque pleine largeur.
    this.page.drawRectangle({
      x: 0,
      y: top - HEADER_BAND_HEIGHT,
      width: this.theme.page.width,
      height: HEADER_BAND_HEIGHT,
      color: color.brand,
    });
    // Filet d'accent foncé en bas du bandeau.
    this.page.drawRectangle({
      x: 0,
      y: top - HEADER_BAND_HEIGHT,
      width: this.theme.page.width,
      height: 3,
      color: color.brandDark,
    });

    const textLeft = this.contentLeft;
    let logoSpace = 0;

    // Logo (ou pastille initiale) dans un cartouche blanc arrondi à droite.
    const badgeSize = 56;
    const badgeX = this.contentRight - badgeSize;
    const badgeY = top - HEADER_BAND_HEIGHT + (HEADER_BAND_HEIGHT - badgeSize) / 2;
    this.page.drawRectangle({
      x: badgeX,
      y: badgeY,
      width: badgeSize,
      height: badgeSize,
      color: color.onBrand,
      borderColor: color.brandDark,
      borderWidth: 0.5,
      opacity: 1,
    });

    if (this.logoImage) {
      const pad = 6;
      const maxDim = badgeSize - pad * 2;
      const scale = Math.min(maxDim / this.logoImage.width, maxDim / this.logoImage.height, 1);
      const w = this.logoImage.width * scale;
      const h = this.logoImage.height * scale;
      this.page.drawImage(this.logoImage, {
        x: badgeX + (badgeSize - w) / 2,
        y: badgeY + (badgeSize - h) / 2,
        width: w,
        height: h,
      });
    } else {
      // Fallback élégant : initiales de l'école sur fond de marque.
      const initials = this.schoolInitials();
      this.drawText(this.page, badgeX, badgeY + badgeSize / 2 - 8, initials, {
        font: this.fonts.bold,
        size: 18,
        color: color.brand,
        maxWidth: badgeSize,
        align: 'center',
      });
    }
    logoSpace = badgeSize + 16;

    // Nom de l'école (eyebrow) + titre du document.
    this.drawText(this.page, textLeft, top - 34, this.branding.schoolName.toUpperCase(), {
      font: this.fonts.semibold,
      size: size.small,
      color: color.onBrand,
      maxWidth: this.contentWidth - logoSpace,
    });
    this.drawText(this.page, textLeft, top - 56, this.title, {
      font: this.fonts.bold,
      size: size.title,
      color: color.onBrand,
      maxWidth: this.contentWidth - logoSpace,
    });
    if (this.subtitle) {
      this.drawText(this.page, textLeft, top - 74, this.subtitle, {
        font: this.fonts.regular,
        size: size.subtitle,
        color: color.onBrand,
        maxWidth: this.contentWidth - logoSpace,
      });
    }
  }

  private schoolInitials(): string {
    const words = this.branding.schoolName
      .replace(/[^\p{L}\s]/gu, '')
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) return 'É';
    if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }

  private drawFooter(): void {
    const { color, size } = this.theme;
    const y = FOOTER_HEIGHT;

    // Filet de séparation.
    this.page.drawLine({
      start: { x: this.contentLeft, y: y + 8 },
      end: { x: this.contentRight, y: y + 8 },
      thickness: 0.5,
      color: color.border,
    });

    const generatedAt = new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Africa/Abidjan',
    }).format(new Date());

    this.drawText(this.page, this.contentLeft, y - 6, `Généré le ${generatedAt}`, {
      font: this.fonts.regular,
      size: size.caption,
      color: color.faint,
    });
    this.drawText(this.page, this.contentLeft, y - 18, 'Document généré par EduTrack CI', {
      font: this.fonts.regular,
      size: size.caption,
      color: color.faint,
    });
    // Numéro de page (rempli en post-traitement une fois le total connu).
    this.drawText(this.page, this.contentRight - 120, y - 6, `Page ${this.pageNumber}`, {
      font: this.fonts.medium,
      size: size.caption,
      color: color.faint,
      maxWidth: 120,
      align: 'right',
    });
  }

  /** Réserve de l'espace ; ajoute une page si le contenu ne tient pas. */
  private ensureSpace(height: number): void {
    if (this.cursorY - height < this.contentBottom) {
      this.addPage();
    }
  }

  // ── Primitives publiques ───────────────────────────────────────────────

  /** Espace vertical. */
  space(amount: number): void {
    this.cursorY -= amount;
  }

  sectionTitle(text: string): void {
    this.ensureSpace(28);
    const { color, size } = this.theme;
    // Petit accent vertical façon « onglet ».
    this.page.drawRectangle({
      x: this.contentLeft,
      y: this.cursorY - 2,
      width: 3,
      height: 13,
      color: color.brand,
    });
    this.drawText(this.page, this.contentLeft + 9, this.cursorY, text, {
      font: this.fonts.semibold,
      size: size.sectionTitle,
      color: color.ink,
    });
    this.cursorY -= 22;
  }

  /** Paragraphe wrap auto. */
  paragraph(text: string, opts?: { color?: RGB; size?: number; font?: PDFFont }): void {
    const font = opts?.font ?? this.fonts.regular;
    const fsize = opts?.size ?? this.theme.size.body;
    const lines = this.wrap(text, font, fsize, this.contentWidth);
    const lineHeight = fsize * 1.5;
    for (const line of lines) {
      this.ensureSpace(lineHeight);
      this.drawText(this.page, this.contentLeft, this.cursorY, line, {
        font,
        size: fsize,
        color: opts?.color ?? this.theme.color.muted,
      });
      this.cursorY -= lineHeight;
    }
  }

  /**
   * Rangée de cartes KPI (chiffre-clé + libellé). 2 à 4 cartes par rangée.
   * La donnée importante est grande (kpiValue), le libellé discret — cf. AGENTS.md §3.
   */
  kpiRow(
    cards: Array<{ label: string; value: string; accent?: RGB; valueColor?: RGB }>
  ): void {
    const { color, size } = this.theme;
    const gap = 12;
    const count = cards.length;
    const cardW = (this.contentWidth - gap * (count - 1)) / count;
    const cardH = 56;
    this.ensureSpace(cardH + 6);
    const top = this.cursorY;

    cards.forEach((card, i) => {
      const x = this.contentLeft + i * (cardW + gap);
      const yBottom = top - cardH;
      // Surface.
      this.page.drawRectangle({
        x,
        y: yBottom,
        width: cardW,
        height: cardH,
        color: color.surface,
        borderColor: color.border,
        borderWidth: 0.75,
      });
      // Liseré d'accent à gauche.
      this.page.drawRectangle({
        x,
        y: yBottom,
        width: 3,
        height: cardH,
        color: card.accent ?? color.brand,
      });
      this.drawText(this.page, x + 14, top - 18, card.label.toUpperCase(), {
        font: this.fonts.semibold,
        size: size.kpiLabel,
        color: color.muted,
        maxWidth: cardW - 22,
      });
      // Auto-ajuste la taille du chiffre-clé pour qu'il tienne sans troncature :
      // le montant (ex. « 1 739 500 FCFA ») reste lisible quel que soit le nombre
      // de cartes dans la rangée.
      const availW = cardW - 28;
      let valueSize = size.kpiValue;
      while (
        valueSize > 9 &&
        this.fonts.bold.widthOfTextAtSize(card.value, valueSize) > availW
      ) {
        valueSize -= 0.5;
      }
      this.drawText(this.page, x + 14, top - 42, card.value, {
        font: this.fonts.bold,
        size: valueSize,
        color: card.valueColor ?? color.ink,
        maxWidth: cardW - 22,
      });
    });

    this.cursorY = top - cardH - 4;
  }

  /** Ligne « libellé : valeur » sur deux colonnes, type fiche d'identité. */
  definitionList(items: Array<{ label: string; value: string }>): void {
    const { color, size } = this.theme;
    const colGap = 24;
    const colW = (this.contentWidth - colGap) / 2;
    const rowH = 18;
    const rows = Math.ceil(items.length / 2);
    this.ensureSpace(rows * rowH + 6);

    items.forEach((item, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = this.contentLeft + col * (colW + colGap);
      const y = this.cursorY - row * rowH;
      this.drawText(this.page, x, y, item.label, {
        font: this.fonts.medium,
        size: size.small,
        color: color.muted,
        maxWidth: colW * 0.42,
      });
      this.drawText(this.page, x + colW * 0.46, y, item.value, {
        font: this.fonts.semibold,
        size: size.small,
        color: color.ink,
        maxWidth: colW * 0.54,
      });
    });
    this.cursorY -= rows * rowH + 4;
  }

  /**
   * Table professionnelle : en-tête de marque, lignes zébrées, pastilles de
   * statut, pagination automatique avec ré-affichage de l'en-tête de colonnes.
   */
  table(options: TableOptions): void {
    const { color, size } = this.theme;
    const rowHeight = options.rowHeight ?? 22;
    const headerHeight = 24;
    const zebra = options.zebra ?? true;
    const padX = 8;

    if (options.title) {
      this.sectionTitle(options.title);
    }

    const drawColumnHeader = (): void => {
      this.ensureSpace(headerHeight);
      const top = this.cursorY;
      this.page.drawRectangle({
        x: this.contentLeft,
        y: top - headerHeight,
        width: this.contentWidth,
        height: headerHeight,
        color: color.brand,
      });
      let cx = this.contentLeft;
      for (const col of options.columns) {
        this.drawText(this.page, cx + padX, top - headerHeight + 8, col.header.toUpperCase(), {
          font: this.fonts.semibold,
          size: size.caption,
          color: color.onBrand,
          maxWidth: col.width - padX * 2,
          align: col.align,
        });
        cx += col.width;
      }
      this.cursorY = top - headerHeight;
    };

    drawColumnHeader();

    options.rows.forEach((row, rowIndex) => {
      if (this.cursorY - rowHeight < this.contentBottom) {
        this.addPage();
        drawColumnHeader();
      }
      const top = this.cursorY;
      if (zebra && rowIndex % 2 === 1) {
        this.page.drawRectangle({
          x: this.contentLeft,
          y: top - rowHeight,
          width: this.contentWidth,
          height: rowHeight,
          color: color.zebra,
        });
      }
      let cx = this.contentLeft;
      const textY = top - rowHeight + (rowHeight - size.small) / 2 + 1;
      row.forEach((cell, colIndex) => {
        const col = options.columns[colIndex]!;
        if (cell.pill) {
          // Pastille de statut centrée verticalement.
          const pillFont = cell.font ?? this.fonts.semibold;
          const pillText = cell.text;
          const textW = this.measure(pillText, pillFont, size.caption);
          const pillW = Math.min(textW + 14, col.width - padX * 2);
          const pillH = 14;
          const pillX =
            col.align === 'right'
              ? cx + col.width - padX - pillW
              : col.align === 'center'
                ? cx + (col.width - pillW) / 2
                : cx + padX;
          const pillY = top - rowHeight + (rowHeight - pillH) / 2;
          this.page.drawRectangle({
            x: pillX,
            y: pillY,
            width: pillW,
            height: pillH,
            color: cell.pill.bg,
          });
          this.drawText(this.page, pillX, pillY + 4, pillText, {
            font: pillFont,
            size: size.caption,
            color: cell.pill.fg,
            maxWidth: pillW,
            align: 'center',
          });
        } else {
          this.drawText(this.page, cx + padX, textY, cell.text, {
            font: cell.font ?? this.fonts.regular,
            size: size.small,
            color: cell.color ?? color.ink,
            maxWidth: col.width - padX * 2,
            align: col.align,
          });
        }
        cx += col.width;
      });
      // Filet de séparation discret sous chaque ligne.
      this.page.drawLine({
        start: { x: this.contentLeft, y: top - rowHeight },
        end: { x: this.contentRight, y: top - rowHeight },
        thickness: 0.4,
        color: color.border,
      });
      this.cursorY = top - rowHeight;
    });
  }

  /** Bandeau de total mis en avant (ex : « Net à payer »). */
  totalBanner(label: string, value: string, opts?: { accent?: RGB }): void {
    const { color, size } = this.theme;
    const h = 38;
    this.ensureSpace(h + 8);
    this.space(6);
    const top = this.cursorY;
    const accent = opts?.accent ?? color.brand;
    this.page.drawRectangle({
      x: this.contentLeft,
      y: top - h,
      width: this.contentWidth,
      height: h,
      color: color.surface,
      borderColor: accent,
      borderWidth: 1,
    });
    this.page.drawRectangle({
      x: this.contentLeft,
      y: top - h,
      width: 4,
      height: h,
      color: accent,
    });
    this.drawText(this.page, this.contentLeft + 16, top - h / 2 - 4, label.toUpperCase(), {
      font: this.fonts.semibold,
      size: size.small,
      color: color.muted,
    });
    this.drawText(this.page, this.contentLeft, top - h / 2 - 6, value, {
      font: this.fonts.bold,
      size: size.subtitle + 5,
      color: accent,
      maxWidth: this.contentWidth - 16,
      align: 'right',
    });
    this.cursorY = top - h - 4;
  }

  /**
   * Bloc signature en fin de document (sur la dernière page courante, juste
   * au-dessus du pied de page). Lignes pour cachet + signature.
   */
  signatureBlock(): void {
    const { color, size } = this.theme;
    const blockH = 64;
    // Si pas la place, on laisse le bloc en bas de la page courante.
    this.ensureSpace(blockH + 10);
    const lineY = Math.max(this.cursorY - 36, this.contentBottom + 24);
    const colW = (this.contentWidth - 40) / 2;

    const drawSlot = (x: number, label: string): void => {
      this.page.drawLine({
        start: { x, y: lineY },
        end: { x: x + colW, y: lineY },
        thickness: 0.75,
        color: color.faint,
      });
      this.drawText(this.page, x, lineY - 12, label, {
        font: this.fonts.medium,
        size: size.small,
        color: color.muted,
        maxWidth: colW,
      });
    };

    drawSlot(this.contentLeft, 'Cachet de l’établissement');
    drawSlot(
      this.contentLeft + colW + 40,
      `Signature — ${this.branding.signatoryTitle ?? 'Directeur'}`
    );
    this.cursorY = lineY - 18;
  }

  /** Finalise : numérote « Page X / N » sur toutes les pages puis sérialise. */
  async save(): Promise<Uint8Array> {
    const pages = this.pdf.getPages();
    const total = pages.length;
    const { color, size } = this.theme;
    pages.forEach((page, idx) => {
      // Masque l'ancien « Page X » par un rectangle blanc puis réécrit le total.
      const label = `Page ${idx + 1} / ${total}`;
      const w = this.fonts.medium.widthOfTextAtSize(label, size.caption);
      const x = this.contentRight - w;
      page.drawRectangle({
        x: x - 2,
        y: FOOTER_HEIGHT - 8,
        width: w + 6,
        height: 12,
        color: rgbWhite(),
      });
      page.drawText(label, {
        x,
        y: FOOTER_HEIGHT - 6,
        size: size.caption,
        font: this.fonts.medium,
        color: color.faint,
      });
    });
    return this.pdf.save();
  }
}

const rgbWhite = (): RGB => rgb(1, 1, 1);
