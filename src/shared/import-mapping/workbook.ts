import ExcelJS from 'exceljs';
import { normalizeMappingLabel } from './engine.js';

export type ParsedMappingWorkbook = {
  sheetName: string;
  headers: string[];
  rows: Array<{ rowNumber: number; sheetName?: string; values: Record<string, string | number> }>;
};

const cellValue = (value: ExcelJS.CellValue): string | number => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if ('result' in value && value.result !== undefined) {
    return cellValue(value.result as ExcelJS.CellValue);
  }
  if ('text' in value) return String(value.text);
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  return String(value);
};

export const parseMappingWorkbook = async (
  buffer: Buffer,
  options: { multiSheet?: boolean; ignoreSheets?: readonly string[] } = {},
): Promise<ParsedMappingWorkbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const ignored = new Set((options.ignoreSheets ?? []).map((name) => name.toLocaleLowerCase('fr')));
  const candidates = workbook.worksheets.filter((sheet) => sheet.actualRowCount > 0 && !ignored.has(sheet.name.toLocaleLowerCase('fr')));
  const sheets = options.multiSheet ? candidates : candidates.slice(0, 1);
  if (!sheets.length) throw new Error('IMPORT_WORKBOOK_EMPTY');
  const allHeaders = new Map<string, string>();
  const rows: ParsedMappingWorkbook['rows'] = [];
  for (const sheet of sheets) {
    let headerRowNumber = 0;
    let headers: string[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (headerRowNumber > 0) return;
      const detected = Array.from({ length: row.cellCount }, (_, index) =>
        String(cellValue(row.getCell(index + 1).value)).trim()
      );
      if (detected.some(Boolean)) {
        headerRowNumber = rowNumber;
        headers = detected;
      }
    });
    if (headerRowNumber === 0 || headers.length === 0) throw new Error('IMPORT_HEADERS_MISSING');
    if (headers.some((header) => !header)) throw new Error('IMPORT_HEADER_EMPTY');
    const normalized = headers.map((header) => normalizeMappingLabel(header));
    if (new Set(normalized).size !== normalized.length) throw new Error('IMPORT_HEADERS_DUPLICATED');

    for (const header of headers) {
      const key = normalizeMappingLabel(header);
      if (!allHeaders.has(key)) allHeaders.set(key, header);
    }
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNumber) return;
      const values = Object.fromEntries(headers.map((header, index) => [
        header,
        cellValue(row.getCell(index + 1).value),
      ]));
      if (Object.values(values).some((value) => String(value).trim() !== '')) {
        const canonicalValues = Object.fromEntries(Object.entries(values).map(([header, value]) => [
          allHeaders.get(normalizeMappingLabel(header))!, value,
        ]));
        rows.push({ rowNumber, ...(options.multiSheet ? { sheetName: sheet.name } : {}), values: canonicalValues });
      }
    });
  }
  return { sheetName: sheets[0]!.name, headers: [...allHeaders.values()], rows };
};
