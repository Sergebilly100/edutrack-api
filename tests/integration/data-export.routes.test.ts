import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';

import { getAuthHeaders, queryPublic, request, TEST_SCHEMA_NAME } from './setup.js';

const binary = (response: import('superagent').Response, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
};

const firstSheet = async (buffer: Buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook.worksheets[0]!;
};

describe('exports Excel élèves / professeurs (point 12)', () => {
  afterEach(async () => {
    await queryPublic(`UPDATE public.tenants SET can_export_data = true WHERE schema_name = $1`, [TEST_SCHEMA_NAME]);
  });

  it('exporte les élèves de l’année active en .xlsx', async () => {
    const headers = await getAuthHeaders('director');
    const response = await request().get('/api/v1/students/export').set(headers).buffer(true).parse(binary);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(response.headers['content-disposition']).toMatch(/eleves-.*\.xlsx/);
    const sheet = await firstSheet(response.body as Buffer);
    expect(sheet.getRow(1).getCell(2).value).toBe('Nom');
  });

  it('exporte les professeurs en .xlsx', async () => {
    const headers = await getAuthHeaders('director');
    const response = await request().get('/api/v1/teachers/export').set(headers).buffer(true).parse(binary);
    expect(response.status).toBe(200);
    const sheet = await firstSheet(response.body as Buffer);
    expect(sheet.getRow(1).getCell(2).value).toBe('Nom complet');
  });

  it('refuse l’export quand le réglage de l’école le désactive', async () => {
    await queryPublic(`UPDATE public.tenants SET can_export_data = false WHERE schema_name = $1`, [TEST_SCHEMA_NAME]);
    const headers = await getAuthHeaders('director');
    for (const path of ['/api/v1/students/export', '/api/v1/teachers/export']) {
      const response = await request().get(path).set(headers);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('EXPORT_DISABLED');
    }
  });

  it('refuse l’export des élèves à un professeur', async () => {
    const headers = await getAuthHeaders('teacher');
    expect((await request().get('/api/v1/students/export').set(headers)).status).toBe(403);
  });
});
