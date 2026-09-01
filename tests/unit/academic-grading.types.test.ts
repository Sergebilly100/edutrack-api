import { describe, expect, it } from 'vitest';

import { createSubjectsBulkBodySchema } from '../../src/modules/academic/academic-grading.types.js';

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
