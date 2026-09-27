import { z } from 'zod';

export const mondayDateSchema = z.iso.date({ error: 'Sélectionnez une date de début valide.' })
  .refine((value) => new Date(`${value}T00:00:00.000Z`).getUTCDay() === 1,
    'La période doit commencer un lundi.');

export const sundayDateSchema = z.iso.date({ error: 'Sélectionnez une date de fin valide.' })
  .refine((value) => new Date(`${value}T00:00:00.000Z`).getUTCDay() === 0,
    'La période doit se terminer un dimanche.');

export const weeklyPeriodSchema = z.object({
  validFrom: mondayDateSchema,
  validTo: sundayDateSchema,
}).refine((value) => value.validFrom <= value.validTo, {
  message: 'La date de fin doit être postérieure ou égale à la date de début.',
  path: ['validTo'],
});
