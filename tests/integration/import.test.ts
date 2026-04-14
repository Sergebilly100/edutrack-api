import * as XLSX from 'xlsx';
import type { Test } from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  request,
  tenantTable,
} from './setup.js';

const toWorkbookBuffer = (rows: Record<string, string>[]): Buffer => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

const attachStudentsFile = (req: Test, rows: Record<string, string>[]) => {
  return req.attach('file', toWorkbookBuffer(rows), {
    filename: 'students.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
};

describe('import integration (real db)', () => {
  it('POST /api/v1/import/students/dry-run avec 10 lignes valides retourne valid=10, errors=[]', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const rows = Array.from({ length: 10 }, (_, index) => ({
      'Prénom*': `DryFirst${index + 1}`,
      'Nom*': `DryLast${index + 1}`,
      'Classe*': context.className,
      'Téléphone parent': `225070000${String(index + 1).padStart(4, '0')}`,
    }));

    const response = await attachStudentsFile(
      request().post('/api/v1/import/students/dry-run').set(headers),
      rows
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      valid: 10,
      errors: [],
    });
  });

  it('POST /api/v1/import/students/dry-run avec 3 lignes invalides retourne les bons numéros de ligne', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const rows = [
      {
        'Prénom*': '',
        'Nom*': 'BadRowOne',
        'Classe*': context.className,
        'Téléphone parent': '2250700000001',
      },
      {
        'Prénom*': 'Bad',
        'Nom*': 'RowTwo',
        'Classe*': 'Classe inconnue',
        'Téléphone parent': '2250700000002',
      },
      {
        'Prénom*': 'Bad',
        'Nom*': 'RowThree',
        'Classe*': context.className,
        'Téléphone parent': '0700000000',
      },
    ];

    const response = await attachStudentsFile(
      request().post('/api/v1/import/students/dry-run').set(headers),
      rows
    );

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(0);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 2, column: 'Prénom*' }),
        expect.objectContaining({ row: 3, column: 'Classe*' }),
        expect.objectContaining({ row: 4, column: 'Téléphone parent' }),
      ])
    );
  });

  it('POST /api/v1/import/students/confirm persiste 10 élèves en DB', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const prefix = `confirm_${Date.now()}`;

    const rows = Array.from({ length: 10 }, (_, index) => ({
      'Prénom*': `${prefix}_first_${index + 1}`,
      'Nom*': `${prefix}_last_${index + 1}`,
      'Classe*': context.className,
      'Téléphone parent': `225070001${String(index + 1).padStart(4, '0')}`,
    }));

    const response = await attachStudentsFile(
      request().post('/api/v1/import/students/confirm').set(headers),
      rows
    );

    expect(response.status).toBe(200);

    const rowsInDb = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('students')}
        WHERE first_name LIKE $1
      `,
      [`${prefix}_first_%`]
    );

    expect(Number(rowsInDb[0]?.count ?? 0)).toBe(10);
  });

  it("POST /api/v1/import/students/confirm est idempotent (rejeu => pas de doublons)", async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const prefix = `idem_${Date.now()}`;

    const rows = Array.from({ length: 10 }, (_, index) => ({
      'Prénom*': `${prefix}_first_${index + 1}`,
      'Nom*': `${prefix}_last_${index + 1}`,
      'Classe*': context.className,
      'Téléphone parent': `225070002${String(index + 1).padStart(4, '0')}`,
    }));

    const first = await attachStudentsFile(
      request().post('/api/v1/import/students/confirm').set(headers),
      rows
    );
    const second = await attachStudentsFile(
      request().post('/api/v1/import/students/confirm').set(headers),
      rows
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rowsInDb = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('students')}
        WHERE first_name LIKE $1
      `,
      [`${prefix}_first_%`]
    );

    expect(Number(rowsInDb[0]?.count ?? 0)).toBe(10);
  });
});
