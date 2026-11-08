import { randomUUID } from 'node:crypto';

import {
  EXTENSION_BY_TYPE,
  ImageValidationError,
  LOGO_MAX_WIDTH,
  LOGO_MIN_SIDE,
  MAX_UPLOAD_BYTES,
  MIME_BY_TYPE,
  SEAL_MAX_WIDTH,
  SEAL_MIN_HEIGHT,
  SEAL_MIN_WIDTH,
  inspectImage,
  processToPng,
  sanitizeOriginal,
} from '../../shared/image/image-processing.js';
import { SafeFetchError, safeFetchBuffer } from '../../shared/image/safe-fetch.js';

import { PermissionsModuleError } from './permissions.service.js';
import type { SchoolIdentityRepository, SchoolIdentityRow } from './school-identity.repository.js';

export type IdentityStorage = {
  isConfigured: () => boolean;
  putPrivate: (key: string, body: Buffer, contentType: string) => Promise<void>;
  putPublic: (key: string, body: Buffer, contentType: string) => Promise<string>;
  read: (key: string) => Promise<Buffer>;
  remove: (key: string) => Promise<void>;
  keyFromPublicUrl: (url: string | null | undefined) => string | null;
};

export type ImageKind = 'logo' | 'seal';
export type SealVariant = 'processed' | 'original';

type Logger = { warn: (obj: Record<string, unknown>, msg: string) => void };

const toIso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** Nom affichable : sans chemin ni caractères de contrôle. Jamais utilisé comme clé de stockage. */
export const sanitizeFileName = (raw: string | undefined): string => {
  // eslint-disable-next-line no-control-regex
  const cleaned = (raw ?? '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'image').slice(0, 200);
};

const FETCH_FAILURE_MESSAGES: Record<SafeFetchError['code'], string> = {
  INVALID_URL: 'Adresse invalide : seules les adresses HTTPS sont acceptées.',
  FORBIDDEN_HOST: 'Cette adresse n’est pas autorisée.',
  FETCH_FAILED: 'Impossible de télécharger l’image depuis cette adresse.',
  FILE_TOO_LARGE: 'Fichier trop volumineux. Maximum 2 Mo.',
};

export class SchoolIdentityService {
  constructor(
    private readonly repository: SchoolIdentityRepository,
    private readonly storage: IdentityStorage,
    private readonly logger?: Logger
  ) {}

  private requireStorage(): void {
    if (!this.storage.isConfigured()) {
      throw new PermissionsModuleError('Stockage des images indisponible.', 503, 'STORAGE_NOT_CONFIGURED');
    }
  }

  private async requireRow(schemaName: string): Promise<SchoolIdentityRow> {
    const row = await this.repository.getIdentity(schemaName);
    if (!row) throw new PermissionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    return row;
  }

  /** Les erreurs de validation image deviennent des 400 lisibles ; le reste remonte tel quel. */
  private static toModuleError(error: unknown): unknown {
    if (error instanceof ImageValidationError) {
      return new PermissionsModuleError(error.message, 400, error.code);
    }
    return error;
  }

  async getIdentity(schemaName: string) {
    const row = await this.requireRow(schemaName);
    const hasSeal = Boolean(row.seal_processed_key && row.seal_original_key);
    return {
      logo: row.logo_url
        ? {
            url: row.logo_url,
            fileName: row.logo_file_name,
            mime: row.logo_mime,
            sizeBytes: row.logo_size_bytes,
            width: row.logo_width,
            height: row.logo_height,
            updatedAt: toIso(row.logo_updated_at),
          }
        : null,
      seal: hasSeal
        ? {
            fileName: row.seal_file_name,
            mime: row.seal_mime,
            sizeBytes: row.seal_size_bytes,
            width: row.seal_width,
            height: row.seal_height,
            removeWhite: row.seal_remove_white ?? false,
            updatedAt: toIso(row.seal_updated_at),
          }
        : null,
      // Anciennes images séparées : exposées via l'API authentifiée uniquement (pas d'URL R2 renvoyée).
      legacy: {
        stamp: Boolean(row.stamp_image_url),
        signature: Boolean(row.signature_image_url),
      },
    };
  }

  /** Aperçu avant enregistrement : valide et traite sans rien stocker. */
  async preview(kind: ImageKind, buffer: Buffer, removeWhite: boolean) {
    try {
      if (kind === 'seal') {
        const { width, height, type } = await inspectImage(buffer, { width: SEAL_MIN_WIDTH, height: SEAL_MIN_HEIGHT });
        const processed = await processToPng(buffer, { maxWidth: SEAL_MAX_WIDTH, removeWhite });
        return { bytes: processed.bytes, mime: 'image/png', sourceWidth: width, sourceHeight: height, sourceType: type };
      }
      const { width, height, type } = await inspectImage(buffer, { width: LOGO_MIN_SIDE, height: LOGO_MIN_SIDE });
      const processed = await sanitizeOriginal(buffer, type, LOGO_MAX_WIDTH);
      return { bytes: processed, mime: MIME_BY_TYPE[type], sourceWidth: width, sourceHeight: height, sourceType: type };
    } catch (error) {
      throw SchoolIdentityService.toModuleError(error);
    }
  }

  async saveSeal(schemaName: string, input: { buffer: Buffer; fileName: string; removeWhite: boolean }) {
    this.requireStorage();
    await this.requireRow(schemaName);
    let originalBytes: Buffer;
    let processed: Awaited<ReturnType<typeof processToPng>>;
    let type: Awaited<ReturnType<typeof inspectImage>>['type'];
    try {
      ({ type } = await inspectImage(input.buffer, { width: SEAL_MIN_WIDTH, height: SEAL_MIN_HEIGHT }));
      originalBytes = await sanitizeOriginal(input.buffer, type);
      processed = await processToPng(input.buffer, { maxWidth: SEAL_MAX_WIDTH, removeWhite: input.removeWhite });
    } catch (error) {
      throw SchoolIdentityService.toModuleError(error);
    }

    const id = randomUUID();
    const originalKey = `school-seals/${schemaName}/${id}-original.${EXTENSION_BY_TYPE[type]}`;
    const processedKey = `school-seals/${schemaName}/${id}-processed.png`;
    await this.storage.putPrivate(originalKey, originalBytes, MIME_BY_TYPE[type]);
    await this.storage.putPrivate(processedKey, processed.bytes, 'image/png');

    try {
      const previous = await this.repository.replaceSeal(schemaName, {
        originalKey,
        processedKey,
        fileName: sanitizeFileName(input.fileName),
        mime: MIME_BY_TYPE[type],
        sizeBytes: input.buffer.length,
        width: processed.width,
        height: processed.height,
        removeWhite: input.removeWhite,
      });
      await this.removeKeys(schemaName, [previous?.previousOriginalKey, previous?.previousProcessedKey]);
    } catch (error) {
      await this.removeKeys(schemaName, [originalKey, processedKey]);
      throw error;
    }
    return this.getIdentity(schemaName);
  }

  /** Recalcule la version traitée depuis l'original conservé (non destructif, réversible). */
  async setSealBackground(schemaName: string, removeWhite: boolean) {
    this.requireStorage();
    const row = await this.requireRow(schemaName);
    if (!row.seal_original_key) {
      throw new PermissionsModuleError('Aucune image enregistrée.', 404, 'SEAL_NOT_FOUND');
    }
    const original = await this.storage.read(row.seal_original_key);
    let processed: Awaited<ReturnType<typeof processToPng>>;
    try {
      processed = await processToPng(original, { maxWidth: SEAL_MAX_WIDTH, removeWhite });
    } catch (error) {
      throw SchoolIdentityService.toModuleError(error);
    }
    const processedKey = `school-seals/${schemaName}/${randomUUID()}-processed.png`;
    await this.storage.putPrivate(processedKey, processed.bytes, 'image/png');
    try {
      const previousKey = await this.repository.replaceProcessedSeal(schemaName, {
        processedKey,
        removeWhite,
        width: processed.width,
        height: processed.height,
      });
      await this.removeKeys(schemaName, [previousKey]);
    } catch (error) {
      await this.removeKeys(schemaName, [processedKey]);
      throw error;
    }
    return this.getIdentity(schemaName);
  }

  async deleteSeal(schemaName: string) {
    const previous = await this.repository.clearSeal(schemaName);
    if (!previous) throw new PermissionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    await this.removeKeys(schemaName, [previous.originalKey, previous.processedKey]);
    return this.getIdentity(schemaName);
  }

  async readSeal(schemaName: string, variant: SealVariant): Promise<{ bytes: Buffer; mime: string }> {
    const row = await this.requireRow(schemaName);
    const key = variant === 'original' ? row.seal_original_key : row.seal_processed_key;
    if (!key) throw new PermissionsModuleError('Aucune image enregistrée.', 404, 'SEAL_NOT_FOUND');
    const bytes = await this.storage.read(key);
    return { bytes, mime: variant === 'original' ? (row.seal_mime ?? 'image/png') : 'image/png' };
  }

  async deleteLegacySeal(schemaName: string, kind: 'stamp' | 'signature') {
    const previousUrl = await this.repository.clearLegacySeal(schemaName, kind);
    const key = this.storage.keyFromPublicUrl(previousUrl);
    if (key) await this.removeKeys(schemaName, [key]);
    return this.getIdentity(schemaName);
  }

  /** Lecture authentifiée d'une ancienne image séparée (jamais d'URL publique renvoyée au navigateur). */
  async readLegacySeal(schemaName: string, kind: 'stamp' | 'signature'): Promise<{ bytes: Buffer; mime: string }> {
    const row = await this.requireRow(schemaName);
    const url = kind === 'stamp' ? row.stamp_image_url : row.signature_image_url;
    const key = this.storage.keyFromPublicUrl(url);
    if (!key) throw new PermissionsModuleError('Image introuvable.', 404, 'SEAL_NOT_FOUND');
    const bytes = await this.storage.read(key);
    const mime = key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return { bytes, mime };
  }

  async saveLogo(schemaName: string, input: { buffer: Buffer; fileName: string }) {
    this.requireStorage();
    await this.requireRow(schemaName);
    let stored: Buffer;
    let type: Awaited<ReturnType<typeof inspectImage>>['type'];
    let width: number;
    let height: number;
    try {
      ({ type, width, height } = await inspectImage(input.buffer, { width: LOGO_MIN_SIDE, height: LOGO_MIN_SIDE }));
      stored = await sanitizeOriginal(input.buffer, type, LOGO_MAX_WIDTH);
    } catch (error) {
      throw SchoolIdentityService.toModuleError(error);
    }
    const key = `logos/${schemaName}/${randomUUID()}.${EXTENSION_BY_TYPE[type]}`;
    const url = await this.storage.putPublic(key, stored, MIME_BY_TYPE[type]);
    const scale = Math.min(1, LOGO_MAX_WIDTH / width);
    try {
      const previousUrl = await this.repository.replaceLogo(schemaName, {
        url,
        fileName: sanitizeFileName(input.fileName),
        mime: MIME_BY_TYPE[type],
        sizeBytes: input.buffer.length,
        width: Math.round(width * scale),
        height: Math.round(height * scale),
      });
      await this.removeKeys(schemaName, [this.storage.keyFromPublicUrl(previousUrl)]);
    } catch (error) {
      await this.removeKeys(schemaName, [key]);
      throw error;
    }
    return this.getIdentity(schemaName);
  }

  /** Télécharge UNE fois l'image, la valide et en stocke une copie : plus aucun appel externe ensuite. */
  async saveLogoFromUrl(schemaName: string, url: string) {
    let buffer: Buffer;
    try {
      buffer = await safeFetchBuffer(url, { maxBytes: MAX_UPLOAD_BYTES, timeoutMs: 5000 });
    } catch (error) {
      if (error instanceof SafeFetchError) {
        throw new PermissionsModuleError(FETCH_FAILURE_MESSAGES[error.code], 400, error.code);
      }
      throw error;
    }
    let fileName = 'logo';
    try {
      fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || 'logo';
    } catch {
      /* nom par défaut */
    }
    return this.saveLogo(schemaName, { buffer, fileName });
  }

  async deleteLogo(schemaName: string) {
    const previousUrl = await this.repository.replaceLogo(schemaName, null);
    if (previousUrl === undefined) throw new PermissionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    await this.removeKeys(schemaName, [this.storage.keyFromPublicUrl(previousUrl)]);
    return this.getIdentity(schemaName);
  }

  /** Suppression best-effort : un objet orphelin ne doit jamais faire échouer l'opération métier. */
  private async removeKeys(schemaName: string, keys: Array<string | null | undefined>): Promise<void> {
    for (const key of keys) {
      if (!key) continue;
      try {
        await this.storage.remove(key);
      } catch (error) {
        this.logger?.warn(
          { schemaName, err: error instanceof Error ? error.message : 'unknown error' },
          '[school-identity] object removal failed'
        );
      }
    }
  }
}
