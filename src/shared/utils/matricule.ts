/** Keep the code's significant characters; only surrounding whitespace is ignored. */
export const trimMatricule = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  return value.trim() || null;
};

export const matriculeKey = (value: string | null | undefined): string | null =>
  trimMatricule(value)?.toLowerCase() ?? null;

export const isMatriculeUniqueViolation = (error: unknown): boolean => {
  const candidate = typeof error === 'object' && error !== null ? error as { code?: unknown; constraint?: unknown; cause?: unknown } : null;
  const cause = candidate?.cause && typeof candidate.cause === 'object' ? candidate.cause as { code?: unknown; constraint?: unknown } : null;
  const source = cause?.code === '23505' ? cause : candidate;
  return source?.code === '23505' && typeof source.constraint === 'string' && source.constraint.includes('matricule');
};
