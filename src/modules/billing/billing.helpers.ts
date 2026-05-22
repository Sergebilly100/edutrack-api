import { z } from 'zod';

/**
 * Helpers métier pour le module billing.
 * Extrait du controller pour respecter AGENTS.md (pas de logique métier dans le controller).
 */

/**
 * Schema Zod pour valider la structure du résultat d'un job d'export PDF.
 */
export const jobResultSchema = z.object({
  filePath: z.string(),
  fileName: z.string(),
  generatedAt: z.string().optional(),
  fileType: z.enum(['pdf', 'zip']).optional(),
  // Present when the worker uploaded the export to R2. When set, the download
  // endpoint redirects to a presigned URL instead of streaming from disk.
  r2Key: z.string().optional(),
});

export type JobFileResult = z.infer<typeof jobResultSchema>;

/**
 * Résout et valide la structure du résultat d'un job.
 * Remplace le cast unsafe `as Record<string, unknown>` par une validation Zod.
 *
 * @param result - Résultat brut du job (type unknown)
 * @returns Résultat validé ou null si invalide
 */
export const resolveJobFileResult = (result: unknown): JobFileResult | null => {
  const parsed = jobResultSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
};

/**
 * Mappe l'état BullMQ vers un statut métier simplifié.
 *
 * @param state - État BullMQ ('completed', 'active', 'failed', 'waiting', etc.)
 * @returns Statut métier
 */
export const mapJobStatus = (state: string): 'pending' | 'processing' | 'done' | 'failed' => {
  if (state === 'completed') {
    return 'done';
  }

  if (state === 'active') {
    return 'processing';
  }

  if (state === 'failed') {
    return 'failed';
  }

  return 'pending';
};
