import { describe, expect, it } from 'vitest';

import {
  getCountryName, getDemonym, isValidCountryCode, listCountries, parseNationality,
} from '../../src/shared/utils/nationality.js';

describe('nationality util', () => {
  it('résout un code en nom français', () => {
    expect(getCountryName('CI')).toBe("Côte d'Ivoire");
    expect(getCountryName('bf')).toBe('Burkina Faso');
    expect(getCountryName('FR')).toBe('France');
  });

  it('donne le gentilé masculin et féminin', () => {
    expect(getDemonym('CI', 'M')).toBe('Ivoirien');
    expect(getDemonym('CI', 'F')).toBe('Ivoirienne');
    expect(getDemonym('ML', null)).toBe('Malien');
    expect(getDemonym('SN', 'F')).toBe('Sénégalaise');
  });

  it('retombe sur le nom du pays quand le gentilé est inconnu', () => {
    expect(getDemonym('NZ', 'M')).toBe(getCountryName('NZ'));
    expect(getDemonym('NZ', 'F')).toBe(getCountryName('NZ'));
  });

  it('couvre les pays courants de la région', () => {
    for (const code of ['CI', 'BF', 'ML', 'GN', 'SN', 'GH', 'BJ', 'TG', 'NE', 'NG', 'LR', 'CM', 'GA', 'CG', 'CD', 'MR', 'MA', 'DZ', 'TN', 'FR', 'LB']) {
      expect(isValidCountryCode(code)).toBe(true);
      expect(getDemonym(code, 'M')).not.toBe(getCountryName(code));
    }
  });

  it('reconnaît un gentilé écrit sans accent ou avec une casse différente', () => {
    expect(parseNationality('ivoirienne')).toBe('CI');
    expect(parseNationality('Camerounaise')).toBe('CM');
    expect(parseNationality('Egyptienne')).toBe('EG');
    // Faute de frappe (et non accent manquant) : refusée.
    expect(parseNationality('Ivoiriene')).toBeNull();
    expect(parseNationality('  IVOIRIEN ')).toBe('CI');
    expect(parseNationality('senegalaise')).toBe('SN');
    expect(parseNationality('Guineenne')).toBe('GN');
  });

  it('reconnaît un code, un nom de pays et refuse le reste', () => {
    expect(parseNationality('ci')).toBe('CI');
    expect(parseNationality("Côte d'Ivoire")).toBe('CI');
    expect(parseNationality('Cote d’Ivoire')).toBe('CI');
    expect(parseNationality('Burkina Faso')).toBe('BF');
    expect(parseNationality('Atlantide')).toBeNull();
    expect(parseNationality('')).toBeNull();
    expect(parseNationality('ZZ')).toBeNull();
  });

  it('liste tous les pays avec la Côte d’Ivoire en tête', () => {
    const countries = listCountries();
    expect(countries[0]).toEqual({ code: 'CI', name: "Côte d'Ivoire" });
    expect(countries.length).toBe(249);
    expect(new Set(countries.map((country) => country.code)).size).toBe(249);
  });
});
