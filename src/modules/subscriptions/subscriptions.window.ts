/**
 * Règle « fin d'année » : un abonnement (création ou renouvellement) n'est possible que tant que
 * l'année scolaire active n'est pas terminée, et sa durée ne dépasse pas les mois restants de l'année.
 * Fonctions pures : la date du jour est fournie (fuseau de l'école) par l'appelant.
 */
export type SchoolYearWindow = { id: string; label: string; endDate: string };

export type SubscriptionAvailability =
  | { canSubscribe: true; remainingMonths: number; schoolYearLabel: string; schoolYearEndDate: string }
  | { canSubscribe: false; reason: 'NO_ACTIVE_SCHOOL_YEAR' | 'SCHOOL_YEAR_ENDED'; message: string; remainingMonths: 0; schoolYearLabel: string | null; schoolYearEndDate: string | null };

/** Mois civils restants, mois en cours inclus (aujourd'hui 8 nov, fin 31 déc → 2). 0 si l'année est terminée. */
export const remainingMonthsInYear = (today: string, endDate: string): number => {
  if (today > endDate) return 0;
  const [todayYear, todayMonth] = today.split('-').map(Number);
  const [endYear, endMonth] = endDate.split('-').map(Number);
  return (endYear - todayYear) * 12 + (endMonth - todayMonth) + 1;
};

export const evaluateSubscriptionAvailability = (today: string, year: SchoolYearWindow | null): SubscriptionAvailability => {
  if (!year) {
    return { canSubscribe: false, reason: 'NO_ACTIVE_SCHOOL_YEAR', remainingMonths: 0, schoolYearLabel: null, schoolYearEndDate: null,
      message: 'Aucune année scolaire n’est active : impossible de créer un abonnement.' };
  }
  const remainingMonths = remainingMonthsInYear(today, year.endDate);
  if (remainingMonths <= 0) {
    return { canSubscribe: false, reason: 'SCHOOL_YEAR_ENDED', remainingMonths: 0, schoolYearLabel: year.label, schoolYearEndDate: year.endDate,
      message: `L’année scolaire ${year.label} est terminée : aucun nouvel abonnement n’est possible.` };
  }
  return { canSubscribe: true, remainingMonths, schoolYearLabel: year.label, schoolYearEndDate: year.endDate };
};
