import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const importTypes = ['students', 'teachers', 'schedule'] as const;

describe('import templates packaging', () => {
  it('keeps all import templates available in the Docker runtime image', () => {
    for (const type of importTypes) {
      expect(existsSync(path.join(process.cwd(), 'templates', `${type}.xlsx`))).toBe(true);
    }

    const dockerignore = readFileSync(path.join(process.cwd(), '.dockerignore'), 'utf8');
    expect(dockerignore.split(/\r?\n/).map((line) => line.trim())).not.toContain('templates/');

    const dockerfile = readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY --from=build /app/templates ./templates');
  });
});

it('C10 ships a profile/contract template without subjects or classes and explains later assignments', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(process.cwd(), 'templates', 'teachers.xlsx'));
  const headers = workbook.worksheets[0].getRow(1).values as string[];
  expect(headers).toContain('Téléphone'); expect(headers).toContain('Email');
  expect(headers.some((header) => /Matière|Classe/.test(header))).toBe(false);
  expect(workbook.getWorksheet('INSTRUCTIONS')?.getRow(3).getCell(1).text).toContain('Après les inscriptions');
});
