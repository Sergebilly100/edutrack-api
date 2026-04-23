const SUBJECT_DISPLAY_BY_KEY: Record<string, string> = {
  mathematique: 'Mathématique',
  francais: 'Français',
  histoire: 'Histoire',
  geographie: 'Géographie',
  'histoire geographie': 'Histoire-Géographie',
  'physique chimie': 'Physique-Chimie',
  svt: 'SVT',
  anglais: 'Anglais',
};

const SUBJECT_KEY_ALIASES: Record<string, string> = {
  math: 'mathematique',
  maths: 'mathematique',
  mathematiques: 'mathematique',
  mathematique: 'mathematique',
};

const normalizeSpaces = (value: string): string => value.trim().replace(/\s+/g, ' ');

const stripDiacritics = (value: string): string =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const singularizeToken = (token: string): string => {
  if (
    token.length > 4 &&
    token.endsWith('es') &&
    !token.endsWith('ais') &&
    !token.endsWith('ois') &&
    !token.endsWith('uis')
  ) {
    return token.slice(0, -1);
  }

  return token;
};

const toTitleCase = (value: string): string =>
  value
    .split(' ')
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : part))
    .join(' ');

export const normalizeSubjectKey = (value: string): string => {
  const cleaned = stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  const normalized = normalizeSpaces(cleaned);
  if (!normalized) {
    return '';
  }

  const singularized = normalized
    .split(' ')
    .map((token) => singularizeToken(token))
    .join(' ');

  return SUBJECT_KEY_ALIASES[singularized] ?? singularized;
};

const fallbackDisplay = (value: string): string => {
  const normalized = normalizeSpaces(value);
  if (!normalized) {
    return '';
  }

  return normalized
    .split('-')
    .map((part) => toTitleCase(normalizeSpaces(part)))
    .join('-');
};

export const canonicalizeSubject = (value: string, knownSubjects?: Iterable<string>): string => {
  const trimmed = normalizeSpaces(value);
  if (!trimmed) {
    return '';
  }

  const key = normalizeSubjectKey(trimmed);
  if (!key) {
    return '';
  }

  if (knownSubjects) {
    for (const known of knownSubjects) {
      if (normalizeSubjectKey(known) === key) {
        return known;
      }
    }
  }

  return SUBJECT_DISPLAY_BY_KEY[key] ?? fallbackDisplay(trimmed);
};

export const canonicalizeSubjectList = (values: string[]): string[] => {
  const byKey = new Map<string, string>();

  for (const item of values) {
    const canonical = canonicalizeSubject(item);
    if (!canonical) {
      continue;
    }
    const key = normalizeSubjectKey(canonical);
    if (!key || byKey.has(key)) {
      continue;
    }
    byKey.set(key, canonical);
  }

  return Array.from(byKey.values());
};
