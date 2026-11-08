import { getCountryName, getDemonym } from '../utils/nationality.js';

/**
 * Formats d'affichage du bulletin (fr-FR). Fonctions pures : aucune donnée n'est recalculée,
 * seule la présentation change. Toute donnée absente devient « — ».
 */

export type Sex = 'M' | 'F';

export const EMPTY_VALUE = '—';

const toSex = (value: string | null | undefined): Sex | null => (value === 'M' || value === 'F' ? value : null);

/** `14,65` : deux décimales, virgule. */
export const formatDecimal = (value: number | null | undefined, digits = 2): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY_VALUE;
  return value.toFixed(digits).replace('.', ',');
};

/** Coefficient : `2`, `2,5` (sans décimale inutile). */
export const formatCoefficient = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY_VALUE;
  return String(Math.round(value * 100) / 100).replace('.', ',');
};

/** `1er`, `2e`, `3e`… ; « — » sans rang. */
export const formatBulletinRank = (rank: number | null | undefined): string => {
  if (typeof rank !== 'number' || !Number.isSafeInteger(rank) || rank < 1) return EMPTY_VALUE;
  return rank === 1 ? '1er' : `${rank}e`;
};

const FR_DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** `2011-05-14` → `14 mai 2011` (date civile, sans fuseau). */
export const formatCivilDate = (value: string | null | undefined): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  if (!match) return EMPTY_VALUE;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? EMPTY_VALUE : FR_DATE.format(date);
};

/** Date d'édition (sans heure) dans le fuseau de l'école. */
export const formatIssueDate = (value: Date): string =>
  new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Abidjan' }).format(value);

export const birthDateLabel = (sex: string | null | undefined): string => {
  const s = toSex(sex);
  return s === 'M' ? 'Né le' : s === 'F' ? 'Née le' : 'Né(e) le';
};

export const formatSex = (sex: string | null | undefined): string => {
  const s = toSex(sex);
  return s === 'M' ? 'Masculin' : s === 'F' ? 'Féminin' : EMPTY_VALUE;
};

/** Gentilé accordé au sexe ; sexe inconnu : nom du pays. */
export const formatNationality = (code: string | null | undefined, sex: string | null | undefined): string => {
  if (!code?.trim()) return EMPTY_VALUE;
  const s = toSex(sex);
  return s ? getDemonym(code, s) : getCountryName(code);
};

export const formatRepeater = (value: boolean | null | undefined): string =>
  value === true ? 'Oui' : value === false ? 'Non' : EMPTY_VALUE;

export const formatText = (value: string | null | undefined): string => value?.trim() || EMPTY_VALUE;

/**
 * « Prénom Nom » (convention users.name de l'application) → « Nom P. » avec civilité selon le sexe :
 * « M. Koffi A. », « Mme Traoré F. » ; sexe inconnu : pas de civilité.
 */
export const formatTeacherLabel = (fullName: string, sex: string | null | undefined): string => {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const [first = '', ...rest] = parts;
  const body = rest.length > 0 ? `${rest.join(' ')} ${first.charAt(0).toUpperCase()}.` : first;
  const s = toSex(sex);
  return s === 'M' ? `M. ${body}` : s === 'F' ? `Mme ${body}` : body;
};

/** Deux premiers professeurs séparés par « / » ; « — » si aucun. */
export const formatTeachersCell = (labels: string[]): string => {
  const usable = labels.filter(Boolean).slice(0, 2);
  return usable.length > 0 ? usable.join(' / ') : EMPTY_VALUE;
};
