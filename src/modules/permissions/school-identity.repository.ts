import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

export type SchoolIdentityRow = {
  logo_url: string | null;
  logo_file_name: string | null;
  logo_mime: string | null;
  logo_size_bytes: number | null;
  logo_width: number | null;
  logo_height: number | null;
  logo_updated_at: Date | string | null;
  seal_original_key: string | null;
  seal_processed_key: string | null;
  seal_file_name: string | null;
  seal_mime: string | null;
  seal_size_bytes: number | null;
  seal_width: number | null;
  seal_height: number | null;
  seal_remove_white: boolean | null;
  seal_updated_at: Date | string | null;
  stamp_image_url: string | null;
  signature_image_url: string | null;
};

export type SealRecord = {
  originalKey: string;
  processedKey: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  width: number;
  height: number;
  removeWhite: boolean;
};

export type LogoRecord = {
  url: string;
  fileName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
};

/** Accès SQL à l'identité visuelle (logo, image unique cachet-signature) de public.tenants. */
export class SchoolIdentityRepository {
  constructor(private readonly db: QueryExecutor) {}

  async getIdentity(schemaName: string): Promise<SchoolIdentityRow | null> {
    const result = await this.db.execute<SchoolIdentityRow>(sql`
      SELECT logo_url, logo_file_name, logo_mime, logo_size_bytes, logo_width, logo_height, logo_updated_at,
             seal_original_key, seal_processed_key, seal_file_name, seal_mime, seal_size_bytes,
             seal_width, seal_height, seal_remove_white, seal_updated_at,
             stamp_image_url, signature_image_url
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  /**
   * Remplace l'image unique. Le verrou de ligne (FOR UPDATE) sérialise les envois concurrents :
   * le dernier enregistrement gagne, et les clés remplacées renvoyées sont celles à supprimer.
   */
  async replaceSeal(
    schemaName: string,
    seal: SealRecord
  ): Promise<{ previousOriginalKey: string | null; previousProcessedKey: string | null } | null> {
    const result = await this.db.execute<{ prev_original: string | null; prev_processed: string | null }>(sql`
      WITH previous AS (
        SELECT id, seal_original_key AS prev_original, seal_processed_key AS prev_processed
        FROM public.tenants
        WHERE schema_name = ${schemaName}
        FOR UPDATE
      )
      UPDATE public.tenants t
      SET seal_original_key = ${seal.originalKey},
          seal_processed_key = ${seal.processedKey},
          seal_file_name = ${seal.fileName},
          seal_mime = ${seal.mime},
          seal_size_bytes = ${seal.sizeBytes},
          seal_width = ${seal.width},
          seal_height = ${seal.height},
          seal_remove_white = ${seal.removeWhite},
          seal_updated_at = NOW(),
          updated_at = NOW()
      FROM previous
      WHERE t.id = previous.id
      RETURNING previous.prev_original, previous.prev_processed
    `);
    const row = result.rows[0];
    return row ? { previousOriginalKey: row.prev_original, previousProcessedKey: row.prev_processed } : null;
  }

  async replaceProcessedSeal(
    schemaName: string,
    input: { processedKey: string; removeWhite: boolean; width: number; height: number }
  ): Promise<string | null> {
    const result = await this.db.execute<{ prev_processed: string | null }>(sql`
      WITH previous AS (
        SELECT id, seal_processed_key AS prev_processed
        FROM public.tenants
        WHERE schema_name = ${schemaName} AND seal_original_key IS NOT NULL
        FOR UPDATE
      )
      UPDATE public.tenants t
      SET seal_processed_key = ${input.processedKey},
          seal_remove_white = ${input.removeWhite},
          seal_width = ${input.width},
          seal_height = ${input.height},
          seal_updated_at = NOW(),
          updated_at = NOW()
      FROM previous
      WHERE t.id = previous.id
      RETURNING previous.prev_processed
    `);
    return result.rows[0]?.prev_processed ?? null;
  }

  async clearSeal(
    schemaName: string
  ): Promise<{ originalKey: string | null; processedKey: string | null } | null> {
    const result = await this.db.execute<{ prev_original: string | null; prev_processed: string | null }>(sql`
      WITH previous AS (
        SELECT id, seal_original_key AS prev_original, seal_processed_key AS prev_processed
        FROM public.tenants
        WHERE schema_name = ${schemaName}
        FOR UPDATE
      )
      UPDATE public.tenants t
      SET seal_original_key = NULL, seal_processed_key = NULL, seal_file_name = NULL, seal_mime = NULL,
          seal_size_bytes = NULL, seal_width = NULL, seal_height = NULL, seal_remove_white = false,
          seal_updated_at = NULL, updated_at = NOW()
      FROM previous
      WHERE t.id = previous.id
      RETURNING previous.prev_original, previous.prev_processed
    `);
    const row = result.rows[0];
    return row ? { originalKey: row.prev_original, processedKey: row.prev_processed } : null;
  }

  /** Remplace (ou retire avec null) le logo et ses métadonnées ; renvoie l'ancienne URL. */
  async replaceLogo(schemaName: string, logo: LogoRecord | null): Promise<string | null | undefined> {
    const result = await this.db.execute<{ prev_logo: string | null }>(sql`
      WITH previous AS (
        SELECT id, logo_url AS prev_logo FROM public.tenants WHERE schema_name = ${schemaName} FOR UPDATE
      )
      UPDATE public.tenants t
      SET logo_url = ${logo?.url ?? null},
          logo_file_name = ${logo?.fileName ?? null},
          logo_mime = ${logo?.mime ?? null},
          logo_size_bytes = ${logo?.sizeBytes ?? null},
          logo_width = ${logo?.width ?? null},
          logo_height = ${logo?.height ?? null},
          logo_updated_at = ${logo ? sql`NOW()` : null},
          updated_at = NOW()
      FROM previous
      WHERE t.id = previous.id
      RETURNING previous.prev_logo
    `);
    return result.rows[0] ? result.rows[0].prev_logo : undefined;
  }

  /** Retire une ancienne image séparée ; renvoie l'ancienne URL (null si absente). */
  async clearLegacySeal(schemaName: string, kind: 'stamp' | 'signature'): Promise<string | null> {
    const column = kind === 'stamp' ? sql`stamp_image_url` : sql`signature_image_url`;
    const result = await this.db.execute<{ prev_url: string | null }>(sql`
      WITH previous AS (
        SELECT id, ${column} AS prev_url FROM public.tenants WHERE schema_name = ${schemaName} FOR UPDATE
      )
      UPDATE public.tenants t
      SET ${column} = NULL, updated_at = NOW()
      FROM previous
      WHERE t.id = previous.id
      RETURNING previous.prev_url
    `);
    return result.rows[0]?.prev_url ?? null;
  }
}
