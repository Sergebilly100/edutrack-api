import { describe, expect, it } from 'vitest';

import { createSubjectsBulkBodySchema, updateSubjectsBulkBodySchema } from '../../src/modules/academic/academic-grading.types.js';

describe('createSubjectsBulkBodySchema', () => {
  it('refuse la sélection du même niveau deux fois', () => {
    const levelId = '11111111-1111-4111-8111-111111111111';
    const parsed = createSubjectsBulkBodySchema.safeParse({
      name: 'Mathématiques',
      assignments: [
        { levelId, coefficient: 4 },
        { levelId, coefficient: 3 },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});

describe('updateSubjectsBulkBodySchema', () => {
  it('refuse la sélection de la même matière deux fois', () => {
    const subjectId = '22222222-2222-4222-8222-222222222222';
    const parsed = updateSubjectsBulkBodySchema.safeParse({
      name: 'Mathématiques',
      assignments: [
        { subjectId, levelId: '11111111-1111-4111-8111-111111111111', coefficient: 4 },
        { subjectId, levelId: '33333333-3333-4333-8333-333333333333', coefficient: 3 },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});
