import { randomBytes } from 'node:crypto';

const SAFE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const generateInitialPassword = (length = 10): string => {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SAFE_ALPHABET[bytes[i] % SAFE_ALPHABET.length];
  }
  return out;
};
