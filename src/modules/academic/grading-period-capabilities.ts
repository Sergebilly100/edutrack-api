export type PeriodDates = {
  startDate: string;
  reviewStartDate: string;
  endDate: string;
};

export const getPeriodCapabilities = (
  period: PeriodDates,
  previousReviewStartDate: string | null,
  isCompleted: boolean,
  today: string = new Date().toISOString().slice(0, 10),
) => {
  const entryStart = previousReviewStartDate && previousReviewStartDate > period.startDate
    ? previousReviewStartDate : period.startDate;
  const notesEntryOpen = !isCompleted && today >= entryStart && today < period.reviewStartDate;
  const conductReviewOpen = !isCompleted && today >= period.reviewStartDate;
  return {
    notesEntryOpen,
    conductReviewOpen,
    bulletinGenerationAvailable: conductReviewOpen,
    isClosed: isCompleted,
  };
};

export const validatePeriodSequence = (periods: Array<PeriodDates & { orderIndex: number }>): string | null => {
  const ordered = [...periods].sort((a, b) => a.orderIndex - b.orderIndex);
  for (const [index, period] of ordered.entries()) {
    if (period.startDate > period.reviewStartDate || period.reviewStartDate > period.endDate) {
      return 'Le début de revue doit se situer entre le début et la fin de la période';
    }
    const previous = ordered[index - 1];
    if (previous && (period.startDate <= previous.startDate || period.startDate > previous.reviewStartDate || period.reviewStartDate <= previous.reviewStartDate)) {
      return 'La période suivante doit commencer après le début de la précédente, au plus tard au début de sa revue, et sa propre revue doit commencer plus tard';
    }
  }
  return null;
};

// Existing schools can have several legacy gaps. A director must be able to
// repair one boundary without being blocked by another, untouched boundary.
export const validatePeriodChange = (
  periods: Array<PeriodDates & { orderIndex: number }>,
  changedOrderIndex: number,
): string | null => {
  const ordered = [...periods].sort((a, b) => a.orderIndex - b.orderIndex);
  const index = ordered.findIndex((period) => period.orderIndex === changedOrderIndex);
  if (index < 0) return 'Période introuvable dans le calendrier';
  return validatePeriodSequence(ordered.slice(Math.max(0, index - 1), index + 2));
};
