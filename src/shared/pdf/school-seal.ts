import { sql } from 'drizzle-orm';

import { db } from '../database/db.js';
import { readR2Buffer } from '../storage/r2.js';

import { loadLogo } from './branding.js';
import type { LoadedLogo } from './builder.js';

/**
 * Accès serveur (génération PDF uniquement) à l'identité « cachet et signature du chef de
 * l'établissement » d'une école. Réservé à un usage interne : aucune route HTTP ne l'expose.
 */

type Logger = { warn: (msg: string, meta?: Record<string, unknown>) => void };

export type BulletinSeals = {
  /** Image unique traitée (PNG, prête à intégrer), ou null si l'école n'en a pas. */
  unified: LoadedLogo | null;
  /**
   * Anciennes images séparées, pour le repli : renseignées uniquement quand `unified` est null.
   * Quand une image unique existe, elles ne sont plus utilisées (et ne sont pas lues).
   */
  legacy: { stamp: LoadedLogo | null; signature: LoadedLogo | null };
};

type SealRow = {
  seal_processed_key: string | null;
  stamp_image_url: string | null;
  signature_image_url: string | null;
};

const EMPTY: BulletinSeals = { unified: null, legacy: { stamp: null, signature: null } };

const loadUnified = async (key: string, schemaName: string, logger?: Logger): Promise<LoadedLogo | null> => {
  try {
    const bytes = await readR2Buffer(key);
    return { bytes: new Uint8Array(bytes), format: 'png' };
  } catch (error) {
    // Jamais de contenu d'image ni de donnée personnelle : identifiant d'école et message seulement.
    logger?.warn('[pdf] Unable to read school seal', {
      schemaName,
      error: error instanceof Error ? error.message : 'unknown error',
    });
    return null;
  }
};

/** Délai global de lecture des images du bulletin : au-delà, case vide plutôt qu'un bulletin bloqué. */
const SEAL_LOAD_TIMEOUT_MS = 10_000;

/** Ne lève jamais : tout échec ou dépassement de délai devient une case vide. */
export const loadSchoolSealsForBulletin = async (
  schemaName: string,
  logger?: Logger,
  timeoutMs: number = SEAL_LOAD_TIMEOUT_MS
): Promise<BulletinSeals> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<BulletinSeals>((resolve) => {
    timer = setTimeout(() => {
      logger?.warn('[pdf] School seals load timed out', { schemaName });
      resolve(EMPTY);
    }, timeoutMs);
  });
  try {
    return await Promise.race([readSchoolSeals(schemaName, logger), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const readSchoolSeals = async (schemaName: string, logger?: Logger): Promise<BulletinSeals> => {
  try {
    const result = await db.execute<SealRow>(sql`
      SELECT seal_processed_key, stamp_image_url, signature_image_url
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) return EMPTY;

    if (row.seal_processed_key) {
      const unified = await loadUnified(row.seal_processed_key, schemaName, logger);
      if (unified) return { unified, legacy: { stamp: null, signature: null } };
      // Image unique illisible : repli sur les anciennes images plutôt qu'un bulletin sans cachet.
    }

    return {
      unified: null,
      legacy: {
        stamp: await loadLogo(row.stamp_image_url, logger),
        signature: await loadLogo(row.signature_image_url, logger),
      },
    };
  } catch (error) {
    logger?.warn('[pdf] Unable to load school seals', {
      schemaName,
      error: error instanceof Error ? error.message : 'unknown error',
    });
    return EMPTY;
  }
};
