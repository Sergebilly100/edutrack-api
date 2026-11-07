import { z } from 'zod';

import { isValidCountryCode, normalizeCountryCode } from './nationality.js';

/** Sexe : 'M' | 'F' | null. Chaîne vide traitée comme « non renseigné » (null). */
export const sexSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.enum(['M', 'F']).nullable()
);

/** Code pays ISO 3166-1 alpha-2 (insensible à la casse, normalisé en majuscules). */
export const nationalityCodeSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (value.trim() === '' ? null : normalizeCountryCode(value)) : value),
  z.string().refine(isValidCountryCode, { message: 'Code pays ISO 3166-1 alpha-2 invalide' }).nullable()
);

/** Lieu de naissance : espaces nettoyés, 2 à 120 caractères. */
export const birthPlaceSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (value.replace(/\s+/g, ' ').trim() || null) : value),
  z.string().min(2, 'Le lieu de naissance doit contenir au moins 2 caractères').max(120).nullable()
);

// Les trois champs sont facultatifs. `undefined` = ne pas toucher ; `null` = remettre à « non renseigné ».
export const optionalSexSchema = sexSchema.optional();
export const optionalNationalitySchema = nationalityCodeSchema.optional();
export const optionalBirthPlaceSchema = birthPlaceSchema.optional();

export type Sex = 'M' | 'F';
