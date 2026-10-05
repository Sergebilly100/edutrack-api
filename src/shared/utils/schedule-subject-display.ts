import { normalizeSubjectKey } from './subject-normalization.js';

export type ScheduleSubjectReference = {
  name: string;
  abbreviation: string | null;
};

/** Only one normalized match within the class level may supply a display label. */
export const resolveScheduleSubjectDisplay = (
  subject: string,
  references: readonly ScheduleSubjectReference[]
): string => {
  const key = normalizeSubjectKey(subject);
  if (!key) return subject;

  const matches = references.filter((reference) => normalizeSubjectKey(reference.name) === key);
  if (matches.length !== 1) return subject;
  return matches[0]!.abbreviation?.trim() || subject;
};
