import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';

/**
 * Chargement des polices Noto Sans embarquées.
 *
 * Noto Sans couvre l'intégralité des accents français (é è à ç œ), le symbole
 * € et les caractères de séparation — contrairement aux StandardFonts pdf-lib
 * (WinAnsi) qui rendent mal certains glyphes. C'est ce qui garantit un rendu
 * digne d'une institution.
 *
 * Les fichiers .ttf vivent dans ./assets/fonts. En dev (`tsx`) le module tourne
 * depuis src/ ; en prod il tourne depuis dist/ où `npm run copy-assets` a recopié
 * les polices. Dans les deux cas le chemin relatif au module reste valide.
 */

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'fonts');

export type FontWeight = 'regular' | 'medium' | 'semibold' | 'bold';

const FONT_FILES: Record<FontWeight, string> = {
  regular: 'NotoSans-Regular.ttf',
  medium: 'NotoSans-Medium.ttf',
  semibold: 'NotoSans-SemiBold.ttf',
  bold: 'NotoSans-Bold.ttf',
};

// Cache des octets de police (process-wide) pour éviter de relire le disque à
// chaque génération de PDF dans le worker.
const bytesCache = new Map<FontWeight, Uint8Array>();

const loadFontBytes = async (weight: FontWeight): Promise<Uint8Array> => {
  const cached = bytesCache.get(weight);
  if (cached) {
    return cached;
  }
  const bytes = new Uint8Array(await readFile(join(FONTS_DIR, FONT_FILES[weight])));
  bytesCache.set(weight, bytes);
  return bytes;
};

export type PdfFonts = Record<FontWeight, PDFFont>;

/**
 * Enregistre fontkit sur le document et embarque les 4 graisses Noto Sans.
 * Doit être appelé une fois par document, juste après PDFDocument.create().
 */
export const embedFonts = async (pdf: PDFDocument): Promise<PdfFonts> => {
  pdf.registerFontkit(fontkit);

  const [regular, medium, semibold, bold] = await Promise.all([
    loadFontBytes('regular'),
    loadFontBytes('medium'),
    loadFontBytes('semibold'),
    loadFontBytes('bold'),
  ]);

  // subset: true → seuls les glyphes utilisés sont embarqués, le PDF reste léger.
  const [r, m, s, b] = await Promise.all([
    pdf.embedFont(regular, { subset: true }),
    pdf.embedFont(medium, { subset: true }),
    pdf.embedFont(semibold, { subset: true }),
    pdf.embedFont(bold, { subset: true }),
  ]);

  return { regular: r, medium: m, semibold: s, bold: b };
};
