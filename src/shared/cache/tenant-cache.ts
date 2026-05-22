import { cacheDel } from './redis-cache.js';

/**
 * Invalidate cached tenant lookups when a tenant is created, updated, or suspended.
 * Call this from admin tenant-mutation paths to keep the auth resolution warm-but-correct.
 *
 * Both subdomain and schema variants are flushed because callers may map either way.
 * The cache fails open, so missing one key here is safe (worst case: 5 min staleness).
 */
export const invalidateTenantCache = async (
  identifiers: { subdomain?: string | null; schemaName?: string | null }
): Promise<void> => {
  const keys: string[] = [];
  if (identifiers.subdomain) keys.push(`tenant:subdomain:${identifiers.subdomain}`);
  if (identifiers.schemaName) keys.push(`tenant:schema:${identifiers.schemaName}`);
  if (keys.length > 0) await cacheDel(...keys);
};
