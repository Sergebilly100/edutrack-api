import { describe, expect, it } from 'vitest';

import { getAuthHeaders, queryTenant, request, tenantTable } from './setup.js';

describe('academic bulk subjects integration', () => {
  it('crée une matière pour plusieurs niveaux sans écraser un doublon', async () => {
    const headers = await getAuthHeaders('director');
    const suffix = Date.now().toString(36);
    const levels = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
      VALUES ($1, 910, false), ($2, 911, false)
      RETURNING id
    `, [`Niveau groupé A ${suffix}`, `Niveau groupé B ${suffix}`]);

    const payload = {
      name: 'Mathématiques',
      assignments: [
        { levelId: levels[0]!.id, coefficient: 4 },
        { levelId: levels[1]!.id, coefficient: 3 },
      ],
    };
    const created = await request().post('/api/v1/subjects/bulk').set(headers).send(payload);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ levelId: levels[0]!.id, coefficient: 4 }),
      expect.objectContaining({ levelId: levels[1]!.id, coefficient: 3 }),
    ]));

    const conflict = await request().post('/api/v1/subjects/bulk').set(headers).send(payload);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('SUBJECT_BATCH_CONFLICT');

    const stored = await queryTenant<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM ${tenantTable('subjects')}
      WHERE level_id = ANY(ARRAY[$1::uuid, $2::uuid]) AND name = 'Mathématique'
    `, [levels[0]!.id, levels[1]!.id]);
    expect(Number(stored[0]?.count)).toBe(2);
  });
});
