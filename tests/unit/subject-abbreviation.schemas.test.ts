import { describe, expect, it } from 'vitest';
import {
  createSubjectBodySchema,
  createSubjectsBulkBodySchema,
  updateSubjectBodySchema,
  updateSubjectsBulkBodySchema,
} from '../../src/modules/academic/academic-grading.types.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('subject abbreviation input', () => {
  it('trims a valid value and converts blanks to null on every mutation', () => {
    expect(createSubjectBodySchema.parse({ levelId: id, name: 'Mathématiques', coefficient: 4, abbreviation: ' Maths ' }).abbreviation).toBe('Maths');
    expect(createSubjectBodySchema.parse({ levelId: id, name: 'Mathématiques', coefficient: 4, abbreviation: '  ' }).abbreviation).toBeNull();
    expect(createSubjectsBulkBodySchema.parse({ name: 'Mathématiques', abbreviation: '', assignments: [{ levelId: id, coefficient: 4 }] }).abbreviation).toBeNull();
    expect(updateSubjectsBulkBodySchema.parse({ name: 'Mathématiques', abbreviation: ' Maths ', assignments: [{ subjectId: id, levelId: id, coefficient: 4 }] }).abbreviation).toBe('Maths');
    expect(updateSubjectBodySchema.parse({ abbreviation: '' }).abbreviation).toBeNull();
  });

  it('allows omission and rejects values beyond the column length', () => {
    expect(createSubjectBodySchema.parse({ levelId: id, name: 'Mathématiques', coefficient: 4 }).abbreviation).toBeUndefined();
    expect(updateSubjectBodySchema.safeParse({ abbreviation: 'x'.repeat(31) }).success).toBe(false);
  });
});
