import { describe, expect, it } from 'vitest';
import { isMatriculeUniqueViolation, matriculeKey, trimMatricule } from '../../src/shared/utils/matricule.js';

describe('matricule normalization', () => {
  it('keeps significant characters and permits missing values', () => {
    expect(trimMatricule(' E-001 ')).toBe('E-001');
    expect(matriculeKey(' e-001 ')).toBe('e-001');
    expect(matriculeKey('E- 001')).toBe('e- 001');
    expect(matriculeKey(null)).toBeNull();
    expect(trimMatricule('   ')).toBeNull();
  });

  it('recognizes direct and Drizzle-wrapped normalized index conflicts', () => {
    expect(isMatriculeUniqueViolation({ code: '23505', constraint: 'students_matricule_normalized_unique' })).toBe(true);
    expect(isMatriculeUniqueViolation({ cause: { code: '23505', constraint: 'teachers_matricule_normalized_unique' } })).toBe(true);
    expect(isMatriculeUniqueViolation({ code: '23505', constraint: 'users_phone_unique' })).toBe(false);
  });
});
