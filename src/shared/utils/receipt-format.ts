/**
 * Formateurs uniques des reçus (PDF et API). Le pendant web est `edutrack-web/src/shared/utils/receipt.ts` :
 * les deux appliquent exactement les mêmes règles.
 *
 * - Le numéro est affiché tel qu'émis : les anciens numéros (REC-0000000004, DEMO-…) ne changent jamais.
 * - La date du paiement s'affiche toujours ; l'heure seulement si elle est réellement connue.
 */
const BUSINESS_TIMEZONE = 'Africa/Abidjan';

const DAY = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' });
const LOCAL_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const LOCAL_TIME = new Intl.DateTimeFormat('fr-FR', { timeZone: BUSINESS_TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const SHORT_TIME = new Intl.DateTimeFormat('fr-FR', { timeZone: BUSINESS_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const formatReceiptNumber = (value: string | null | undefined): string => value?.trim() || 'Sans numéro de reçu';

export type PaymentMoment = { date: string; time: string | null; text: string };

/**
 * « 5 nov. 2026 » ou « 5 nov. 2026 à 14:32 ».
 * L'heure n'est affichée que si `paidAt` est connue, tombe le même jour que la date du paiement (fuseau de l'école)
 * et n'est pas minuit exact : jamais de « 00:00 » par défaut.
 */
export const formatPaymentMoment = (input: { paymentDate: string | null | undefined; paidAt?: string | Date | null }): PaymentMoment => {
  const day = input.paymentDate?.slice(0, 10) ?? '';
  const parsedDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00Z`) : null;
  if (!parsedDay || Number.isNaN(parsedDay.getTime())) return { date: 'Date inconnue', time: null, text: 'Date inconnue' };
  const date = DAY.format(parsedDay);
  const paidAt = input.paidAt ? new Date(input.paidAt) : null;
  const known = paidAt !== null && !Number.isNaN(paidAt.getTime())
    && LOCAL_DAY.format(paidAt) === day
    && LOCAL_TIME.format(paidAt) !== '00:00:00';
  const time = known ? SHORT_TIME.format(paidAt!) : null;
  return { date, time, text: time ? `${date} à ${time}` : date };
};
