import { sql } from 'drizzle-orm';

import { db } from '../database/db.js';

import type { DocumentBranding, LoadedLogo } from './builder.js';

/**
 * Récupération du branding d'une école (nom, logo, ville, intitulé du
 * signataire) et décodage robuste du logo, partagés par tous les exports PDF.
 *
 * Extrait de billing.queue.ts pour être réutilisable et testable.
 */

const DEFAULT_SCHOOL_NAME = 'École';

type Logger = { warn: (msg: string, meta?: Record<string, unknown>) => void };

type BrandingRow = {
  name: string | null;
  logo_url: string | null;
  city: string | null;
  director_title: string | null;
};

export const fetchSchoolBranding = async (
  schemaName: string,
  logger?: Logger
): Promise<DocumentBranding> => {
  const result = await db.execute<BrandingRow>(sql`
    SELECT name, logo_url, city, director_title
    FROM public.tenants
    WHERE schema_name = ${schemaName}
    LIMIT 1
  `);

  const row = result.rows[0];
  const schoolName = row?.name?.trim() || DEFAULT_SCHOOL_NAME;
  const city = row?.city?.trim() || null;
  const signatoryTitle = row?.director_title?.trim() || 'Directeur';
  const logo = await loadLogo(row?.logo_url?.trim() || null, logger);

  return {
    schoolName,
    schoolMeta: city,
    signatoryTitle,
    logo,
  };
};

const parseDataUri = (value: string): { contentType: string; data: Uint8Array } | null => {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value.trim());
  if (!match) return null;
  const [, contentType, base64Body] = match;
  try {
    return { contentType, data: Uint8Array.from(Buffer.from(base64Body, 'base64')) };
  } catch {
    return null;
  }
};

const detectImageFormat = (bytes: Uint8Array, contentType?: string): 'png' | 'jpg' | null => {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((v, i) => bytes[i] === v)) return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  const type = contentType?.toLowerCase() ?? '';
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  return null;
};

/**
 * Charge un logo depuis une data-URI ou une URL HTTP(S), avec retry (backoff
 * exponentiel) et détection de format. Renvoie null en cas d'échec — le builder
 * affiche alors un cartouche avec les initiales de l'école.
 */
export const loadLogo = async (
  logoUrl: string | null,
  logger?: Logger
): Promise<LoadedLogo | null> => {
  if (!logoUrl) return null;

  const dataUri = parseDataUri(logoUrl);
  if (dataUri) {
    const format = detectImageFormat(dataUri.data, dataUri.contentType);
    if (!format) {
      logger?.warn('[pdf] Invalid image format in data URI', { logoUrl: logoUrl.slice(0, 48) });
      return null;
    }
    return { bytes: dataUri.data, format };
  }

  if (!/^https?:\/\//i.test(logoUrl)) {
    logger?.warn('[pdf] Invalid logo URL (not http/https)', { logoUrl });
    return null;
  }

  const maxRetries = 3;
  const baseDelay = 500;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(logoUrl, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const format = detectImageFormat(bytes, response.headers.get('content-type') ?? undefined);
      if (!format) {
        logger?.warn('[pdf] Invalid image format from URL', { logoUrl });
        return null;
      }
      return { bytes, format };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
      }
    }
  }

  logger?.warn('[pdf] Failed to load logo after retries', {
    logoUrl,
    attempts: maxRetries,
    error: lastError?.message,
  });
  return null;
};
