import { rgb, type RGB } from 'pdf-lib';

/**
 * Design tokens du système de PDF EduTrack / IvoirEdu.
 *
 * Source de vérité visuelle pour tous les bilans générés côté serveur.
 * Les couleurs reprennent le design system de l'app (AGENTS.md §2) afin que les
 * documents imprimés soient cohérents avec l'interface.
 *
 * ⚠️ Ne jamais hardcoder une couleur ou une taille ailleurs : passer par ce thème.
 */

/** Convertit une couleur HSL (comme dans index.css) en RGB pdf-lib. */
const hsl = (h: number, s: number, l: number): RGB => {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lig - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgb(r + m, g + m, b + m);
};

const hex = (value: string): RGB => {
  const clean = value.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
};

export { hex as hexToRgb };

/**
 * Couleur de marque par défaut = bleu --primary du design system
 * (hsl 221.2 83.2% 53.3%). À terme, une couleur par école pourra surcharger
 * `brand` via le champ de branding (cf. resolveTheme).
 */
const DEFAULT_BRAND = hsl(221.2, 83.2, 53.3);

export type PdfTheme = {
  color: {
    /** Accent principal (bandeau, titres, filets) */
    brand: RGB;
    /** Variante foncée du brand pour le contraste sur surfaces claires */
    brandDark: RGB;
    /** Texte principal (slate-900) */
    ink: RGB;
    /** Texte secondaire (slate-500) */
    muted: RGB;
    /** Texte très discret (slate-400) */
    faint: RGB;
    /** Blanc pur (texte sur bandeau) */
    onBrand: RGB;
    /** Bordures fines (slate-200) */
    border: RGB;
    /** Fond zébré de table (slate-50) */
    zebra: RGB;
    /** Fond des cartes KPI (slate-50) */
    surface: RGB;
    /** États métier (présent / absent / retard) */
    success: RGB;
    successSurface: RGB;
    danger: RGB;
    dangerSurface: RGB;
    warning: RGB;
    warningSurface: RGB;
    neutralSurface: RGB;
    neutralText: RGB;
  };
  size: {
    /** Marge extérieure de page */
    pageMargin: number;
    /** Tailles typographiques */
    title: number;
    subtitle: number;
    sectionTitle: number;
    body: number;
    small: number;
    caption: number;
    kpiValue: number;
    kpiLabel: number;
  };
  page: {
    width: number; // A4 portrait
    height: number;
  };
};

const A4 = { width: 595.28, height: 841.89 };

export const buildTheme = (brand?: RGB): PdfTheme => ({
  color: {
    brand: brand ?? DEFAULT_BRAND,
    brandDark: hsl(221.2, 83.2, 42),
    ink: hsl(222.2, 47, 11),
    muted: hsl(215, 16, 47),
    faint: hsl(214, 15, 64),
    onBrand: rgb(1, 1, 1),
    border: hsl(214.3, 31.8, 88),
    zebra: hsl(210, 40, 98),
    surface: hsl(210, 40, 98),
    success: hsl(142, 71, 35),
    successSurface: hsl(138, 76, 95),
    danger: hsl(0, 72, 47),
    dangerSurface: hsl(0, 86, 96),
    warning: hsl(32, 81, 38),
    warningSurface: hsl(48, 96, 93),
    neutralSurface: hsl(210, 40, 96),
    neutralText: hsl(215, 16, 40),
  },
  size: {
    pageMargin: 42,
    title: 19,
    subtitle: 10.5,
    sectionTitle: 12.5,
    body: 9.5,
    small: 8.5,
    caption: 7.5,
    kpiValue: 17,
    kpiLabel: 7.5,
  },
  page: A4,
});

export const defaultTheme = buildTheme();
