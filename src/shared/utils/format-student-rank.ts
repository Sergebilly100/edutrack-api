/** Formate uniquement un rang d'élève ; l'appelant choisit son état non renseigné. */
export function formatStudentRank(rank: number | null | undefined): string | null {
  if (typeof rank !== 'number' || !Number.isSafeInteger(rank) || rank < 1) return null;
  return rank === 1 ? '1er' : `${rank}ème`;
}

export function formatStudentRankWithHeadcount(
  rank: number | null | undefined,
  headcount: number | null | undefined,
): string | null {
  const label = formatStudentRank(rank);
  if (!label) return null;
  return typeof headcount === 'number' && Number.isSafeInteger(headcount) && headcount > 0
    ? `${label} / ${headcount}`
    : label;
}
