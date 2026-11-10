import ExcelJS from 'exceljs';

/**
 * Génération de classeurs Excel pour les exports de listes (élèves, professeurs).
 *
 * Protection contre l'injection de formules : une cellule texte qui commence par `=`, `+`, `-`, `@`
 * (ou une tabulation / un retour chariot) est préfixée d'une apostrophe pour rester du texte inerte
 * si le fichier est converti en CSV ou rouvert dans un autre tableur. Les numéros de téléphone
 * (« +225 07 00 00 00 00 ») sont reconnus et laissés intacts : ils sont écrits en texte, jamais évalués.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PHONE_LIKE = /^\+?\d[\d\s.()-]*$/;

export const sanitizeCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  if (PHONE_LIKE.test(text)) return text;
  return FORMULA_START.test(text) ? `'${text}` : text;
};

export type ExportColumn = { header: string; key: string; width: number };

export type ExportSheet = {
  name: string;
  columns: readonly ExportColumn[];
  rows: ReadonlyArray<Record<string, unknown>>;
};

/** Toutes les cellules sont écrites en texte (téléphones, matricules, dates JJ/MM/AAAA). */
export const buildExportWorkbook = async (sheet: ExportSheet): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'IvoirEdu';
  const worksheet = workbook.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
  worksheet.columns = sheet.columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
    style: { numFmt: '@' },
  }));
  for (const row of sheet.rows) {
    const safe: Record<string, string> = {};
    for (const column of sheet.columns) safe[column.key] = sanitizeCell(row[column.key]);
    worksheet.addRow(safe);
  }
  const header = worksheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
  if (sheet.columns.length > 0) {
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

/** `eleves-2025-2026-2026-11-08.xlsx` : ASCII uniquement, sûr dans un en-tête HTTP. */
export const exportFileName = (prefix: string, yearLabel: string | null | undefined, today = new Date()): string => {
  const slug = (yearLabel ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const date = today.toISOString().slice(0, 10);
  return [prefix, slug, date].filter(Boolean).join('-') + '.xlsx';
};

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
