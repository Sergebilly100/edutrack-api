const normalizeChunk = (value: string): string => {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
};

export const generateUsername = (
  lastName: string,
  firstName: string,
  existingUsernames: string[]
): string => {
  const normalizedLast = normalizeChunk(lastName) || 'user';
  const normalizedFirst = normalizeChunk(firstName).slice(0, 4) || 'user';
  const base = `${normalizedLast}.${normalizedFirst}`;

  const existing = new Set(existingUsernames.map((username) => username.toLowerCase()));

  if (!existing.has(base)) {
    return base;
  }

  let suffix = 2;
  let candidate = `${base}${suffix}`;

  while (existing.has(candidate)) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }

  return candidate;
};
