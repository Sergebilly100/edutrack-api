import { describe, expect, it } from 'vitest';

import {
  canonicalizeSubject,
  canonicalizeSubjectList,
  normalizeSubjectKey,
} from '../../src/shared/utils/subject-normalization.js';

describe('subject-normalization', () => {
  it('normalise les variantes accent/pluriel de Mathématiques vers Mathématique', () => {
    expect(canonicalizeSubject('Mathématiques')).toBe('Mathématique');
    expect(canonicalizeSubject('Mathematiques')).toBe('Mathématique');
    expect(normalizeSubjectKey('Mathématiques')).toBe(normalizeSubjectKey('Mathematiques'));
  });

  it('réutilise la forme existante du catalogue quand la matière est similaire', () => {
    const known = ['Mathématique'];
    expect(canonicalizeSubject('Mathematiques', known)).toBe('Mathématique');
  });

  it('déduplique une liste de matières proches', () => {
    const result = canonicalizeSubjectList(['Mathématiques', 'Mathematiques', 'Français', 'Francais']);
    expect(result).toEqual(['Mathématique', 'Français']);
  });
});
