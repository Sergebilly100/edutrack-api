import { foldText, parseNationality } from './nationality.js';

/**
 * Parseurs de cellules d'import (Excel) pour les champs d'identité.
 * `value: null` = cellule vide (non renseigné, ne doit PAS effacer l'existant).
 * `error` = valeur non reconnue (erreur de ligne explicite, sans bloquer les autres lignes).
 */
export type CellParse<T> = { value: T | null; error?: string };

const SEX_MALE = new Set(['m', 'masculin', 'garcon', 'homme', 'h']);
const SEX_FEMALE = new Set(['f', 'feminin', 'fille', 'femme']);
const TRUE_VALUES = new Set(['oui', 'o', '1', 'vrai', 'true']);
const FALSE_VALUES = new Set(['non', 'n', '0', 'faux', 'false']);

export const IDENTITY_COLUMN_ALIASES = {
  sex: ['Sexe', 'Genre'],
  nationality: ['Nationalité', 'Nationalite'],
  birthPlace: ['Lieu de naissance', 'Lieu naissance'],
  birthDate: ['Date de naissance'],
  repeating: ['Redoublant', 'Redoublante', 'Redoublant(e)'],
} as const;

/** Lit une colonne par alias, insensible aux accents, à la casse et aux espaces ; retire l'astérisque « requis ». */
export const readColumn = (values: Record<string, string>, aliases: readonly string[]): string => {
  const wanted = new Set(aliases.map((alias) => foldText(alias)));
  for (const [header, cell] of Object.entries(values)) {
    if (wanted.has(foldText(header.replace(/\*+$/, '')))) return cell?.toString().trim() ?? '';
  }
  return '';
};

export const parseSexCell = (raw: string): CellParse<'M' | 'F'> => {
  const key = foldText(raw);
  if (!key) return { value: null };
  if (SEX_MALE.has(key)) return { value: 'M' };
  if (SEX_FEMALE.has(key)) return { value: 'F' };
  return { value: null, error: `Sexe non reconnu : « ${raw.trim()} » (attendu : M, F, Masculin, Féminin, Garçon, Fille)` };
};

export const parseRepeatingCell = (raw: string): CellParse<boolean> => {
  const key = foldText(raw);
  if (!key) return { value: null };
  if (TRUE_VALUES.has(key)) return { value: true };
  if (FALSE_VALUES.has(key)) return { value: false };
  return { value: null, error: `Redoublant non reconnu : « ${raw.trim()} » (attendu : Oui ou Non)` };
};

export const parseNationalityCell = (raw: string): CellParse<string> => {
  if (!raw.trim()) return { value: null };
  const code = parseNationality(raw);
  return code ? { value: code } : { value: null, error: `Nationalité non reconnue : « ${raw.trim()} »` };
};

export const parseBirthPlaceCell = (raw: string): CellParse<string> => {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return { value: null };
  if (cleaned.length < 2 || cleaned.length > 120) {
    return { value: null, error: 'Lieu de naissance : entre 2 et 120 caractères' };
  }
  return { value: cleaned };
};
