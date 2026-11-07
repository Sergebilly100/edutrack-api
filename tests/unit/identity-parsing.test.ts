import { describe, expect, it } from 'vitest';

import {
  IDENTITY_COLUMN_ALIASES, parseBirthPlaceCell, parseNationalityCell, parseRepeatingCell, parseSexCell, readColumn,
} from '../../src/shared/utils/identity-parsing.js';
import {
  birthPlaceSchema, nationalityCodeSchema, optionalBirthPlaceSchema, optionalNationalitySchema, optionalSexSchema,
} from '../../src/shared/utils/identity-schemas.js';

describe('identity import parsing', () => {
  it.each([['M', 'M'], ['masculin', 'M'], ['Garçon', 'M'], ['garcon', 'M'], ['F', 'F'], ['Féminin', 'F'], ['FEMININ', 'F'], ['Fille', 'F']])(
    'sexe %s → %s', (raw, expected) => expect(parseSexCell(raw)).toEqual({ value: expected }));
  it('sexe vide → non renseigné, sexe inconnu → erreur', () => {
    expect(parseSexCell('  ')).toEqual({ value: null });
    expect(parseSexCell('X').error).toContain('Sexe non reconnu');
  });

  it.each([['Oui', true], ['o', true], ['1', true], ['Vrai', true], ['Non', false], ['N', false], ['0', false], ['faux', false]])(
    'redoublant %s → %s', (raw, expected) => expect(parseRepeatingCell(raw)).toEqual({ value: expected }));
  it('redoublant vide → null, inconnu → erreur', () => {
    expect(parseRepeatingCell('')).toEqual({ value: null });
    expect(parseRepeatingCell('peut-être').error).toContain('Redoublant non reconnu');
  });

  it('nationalité : code, pays, gentilé ; erreur explicite sinon', () => {
    expect(parseNationalityCell('CI')).toEqual({ value: 'CI' });
    expect(parseNationalityCell('Ivoirienne')).toEqual({ value: 'CI' });
    expect(parseNationalityCell('')).toEqual({ value: null });
    expect(parseNationalityCell('Ivoiriene').value).toBeNull();
    expect(parseNationalityCell('Ivoiriene').error).toBe('Nationalité non reconnue : « Ivoiriene »');
  });

  it('lieu de naissance : nettoyé, 2 à 120 caractères', () => {
    expect(parseBirthPlaceCell('  Abidjan   Cocody ')).toEqual({ value: 'Abidjan Cocody' });
    expect(parseBirthPlaceCell('')).toEqual({ value: null });
    expect(parseBirthPlaceCell('A').error).toBeDefined();
    expect(parseBirthPlaceCell('x'.repeat(121)).error).toBeDefined();
  });

  it('lit une colonne malgré accents, casse, espaces et astérisque', () => {
    expect(readColumn({ ' NATIONALITE ': 'CI' }, IDENTITY_COLUMN_ALIASES.nationality)).toBe('CI');
    expect(readColumn({ 'lieu  de naissance': 'Bouaké' }, IDENTITY_COLUMN_ALIASES.birthPlace)).toBe('Bouaké');
    expect(readColumn({ 'Sexe*': 'F' }, IDENTITY_COLUMN_ALIASES.sex)).toBe('F');
    expect(readColumn({ Nom: 'x' }, IDENTITY_COLUMN_ALIASES.sex)).toBe('');
  });
});

describe('identity zod schemas', () => {
  it('sexe : M/F seulement, null explicite accepté, undefined conservé', () => {
    expect(optionalSexSchema.parse('M')).toBe('M');
    expect(optionalSexSchema.parse(null)).toBeNull();
    expect(optionalSexSchema.parse(undefined)).toBeUndefined();
    expect(optionalSexSchema.parse('')).toBeNull();
    expect(optionalSexSchema.safeParse('X').success).toBe(false);
  });

  it('nationalité : code ISO valide normalisé en majuscules', () => {
    expect(nationalityCodeSchema.parse('ci')).toBe('CI');
    expect(optionalNationalitySchema.parse(null)).toBeNull();
    expect(optionalNationalitySchema.safeParse('ZZ').success).toBe(false);
    expect(optionalNationalitySchema.safeParse('Ivoirienne').success).toBe(false);
  });

  it('lieu de naissance : espaces nettoyés, bornes 2..120', () => {
    expect(birthPlaceSchema.parse('  Abidjan  ')).toBe('Abidjan');
    expect(optionalBirthPlaceSchema.parse('   ')).toBeNull();
    expect(optionalBirthPlaceSchema.safeParse('A').success).toBe(false);
    expect(optionalBirthPlaceSchema.safeParse('x'.repeat(121)).success).toBe(false);
  });
});
