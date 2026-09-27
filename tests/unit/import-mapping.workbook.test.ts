import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseMappingWorkbook } from '../../src/shared/import-mapping/workbook.js';

describe('shared mapping workbook parsing', () => {
  it('keeps first-sheet behavior for existing recovery imports by default', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('First').addRows([['Nom'], ['First row']]);
    book.addWorksheet('Second').addRows([['Nom'], ['Second row']]);
    const parsed = await parseMappingWorkbook(Buffer.from(await book.xlsx.writeBuffer()));
    expect(parsed.rows).toEqual([{ rowNumber: 2, values: { Nom: 'First row' } }]);
  });
  it('reads all student sheets, ignores documentation and resolves header variants across sheets', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('README').addRows([['Instructions'], ['Not a student']]);
    book.addWorksheet('4e A').addRows([['Nom', 'Nom parent', 'Naissance'], ['Test A', 'Parent A', new Date('2010-03-04T00:00:00Z')]]);
    book.addWorksheet('4e B').addRows([['NAISSANCE', 'NOM', 'NOM  PARENT'], ['2011-01-01', 'Test B', 'Parent B']]);
    const parsed = await parseMappingWorkbook(Buffer.from(await book.xlsx.writeBuffer()), { multiSheet: true, ignoreSheets: ['README'] });
    expect(parsed.headers).toEqual(['Nom', 'Nom parent', 'Naissance']);
    expect(parsed.rows).toEqual([
      { rowNumber: 2, sheetName: '4e A', values: { Nom: 'Test A', 'Nom parent': 'Parent A', Naissance: '2010-03-04' } },
      { rowNumber: 2, sheetName: '4e B', values: { Nom: 'Test B', 'Nom parent': 'Parent B', Naissance: '2011-01-01' } },
    ]);
  });
  it('rejects ambiguous normalized headers instead of silently dropping a column', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('4e A').addRows([['Nom parent', 'NOM  PARENT'], ['A', 'B']]);
    await expect(parseMappingWorkbook(Buffer.from(await book.xlsx.writeBuffer()), { multiSheet: true })).rejects.toThrow('IMPORT_HEADERS_DUPLICATED');
  });
});
