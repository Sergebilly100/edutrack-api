import { describe, expect, it } from 'vitest';

import { getAuthHeaders, queryTenant, request, tenantTable } from './setup.js';

describe('academic bulk subjects integration', () => {
  it('crée une matière pour plusieurs niveaux sans écraser un doublon', async () => {
    const headers = await getAuthHeaders('director');
    const suffix = Date.now().toString(36);
    const levels = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
      VALUES ($1, 910, false), ($2, 911, false), ($3, 912, false)
      RETURNING id
    `, [`Niveau groupé A ${suffix}`, `Niveau groupé B ${suffix}`, `Niveau groupé C ${suffix}`]);

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

    const updated = await request().patch('/api/v1/subjects/bulk').set(headers).send({
      name: 'Sciences physiques',
      assignments: created.body.subjects.map((subject: { id: string; levelId: string }, index: number) => ({
        subjectId: subject.id,
        levelId: subject.levelId,
        coefficient: index === 0 ? 5 : 2,
      })).concat({ levelId: levels[2]!.id, coefficient: 1 }),
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ levelId: levels[0]!.id, coefficient: 5, name: 'Sciences Physiques' }),
      expect.objectContaining({ levelId: levels[1]!.id, coefficient: 2, name: 'Sciences Physiques' }),
      expect.objectContaining({ levelId: levels[2]!.id, coefficient: 1, name: 'Sciences Physiques' }),
    ]));

    const conflict = await request().post('/api/v1/subjects/bulk').set(headers).send({
      ...payload,
      name: 'Sciences physiques',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('SUBJECT_BATCH_CONFLICT');

    const stored = await queryTenant<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM ${tenantTable('subjects')}
      WHERE level_id = ANY(ARRAY[$1::uuid, $2::uuid, $3::uuid]) AND name = 'Sciences Physiques'
    `, [levels[0]!.id, levels[1]!.id, levels[2]!.id]);
    expect(Number(stored[0]?.count)).toBe(3);
  });
});
