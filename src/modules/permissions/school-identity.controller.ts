import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { MAX_UPLOAD_BYTES } from '../../shared/image/image-processing.js';
import { requirePermission } from '../../shared/middleware/auth.middleware.js';

import { PermissionsModuleError } from './permissions.service.js';
import { SchoolIdentityRepository } from './school-identity.repository.js';
import { SchoolIdentityService, type IdentityStorage } from './school-identity.service.js';
import { r2IdentityStorage } from './school-identity.storage.js';

const BASE = '/api/v1/permissions/config/school';

const previewQuerySchema = z.object({
  kind: z.enum(['logo', 'seal']),
  removeWhite: z.enum(['true', 'false']).optional(),
});
const saveSealQuerySchema = z.object({ removeWhite: z.enum(['true', 'false']).optional() });
const backgroundBodySchema = z.object({ removeWhite: z.boolean() });
const imageQuerySchema = z.object({ variant: z.enum(['processed', 'original']).default('processed') });
const legacyParamsSchema = z.object({ kind: z.enum(['stamp', 'signature']) });
const logoFromUrlBodySchema = z.object({ url: z.string().trim().min(8).max(2048) });

const handleError = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: 'Validation error', code: 'BAD_REQUEST', statusCode: 400 });
  }
  if (error instanceof PermissionsModuleError) {
    return reply
      .code(error.statusCode)
      .send({ error: error.message, code: error.code, statusCode: error.statusCode });
  }
  // Ni contenu d'image ni donnée personnelle dans les logs : message d'erreur seul.
  request.log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    '[school-identity] unhandled error'
  );
  return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR', statusCode: 500 });
};

const readUpload = async (request: FastifyRequest): Promise<{ buffer: Buffer; fileName: string }> => {
  const data = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
  if (!data) throw new PermissionsModuleError('Aucun fichier reçu.', 400, 'BAD_REQUEST');
  try {
    // Le type déclaré n'est pas fiable : la validation se fait sur les octets (voir inspectImage).
    return { buffer: await data.toBuffer(), fileName: data.filename };
  } catch (error) {
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new PermissionsModuleError('Fichier trop volumineux. Maximum 2 Mo.', 400, 'FILE_TOO_LARGE');
    }
    throw error;
  }
};

const sendImage = (
  reply: FastifyReply,
  image: { bytes: Buffer; mime: string },
  extraHeaders: Record<string, string> = {}
): FastifyReply =>
  reply
    .headers(extraHeaders)
    .header('Content-Type', image.mime)
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(image.bytes);

export type SchoolIdentityControllerOptions = { storage?: IdentityStorage };

/**
 * Identité visuelle des documents : logo et image unique « cachet et signature du chef de
 * l'établissement ». Toutes les routes exigent `settings.school`, appliqué côté API.
 */
export default async function schoolIdentityController(
  app: FastifyInstance,
  options: SchoolIdentityControllerOptions = {}
): Promise<void> {
  const storage = options.storage ?? r2IdentityStorage;
  const guard = { preHandler: requirePermission('settings.school') };

  const withService = <T>(schemaName: string, run: (service: SchoolIdentityService) => Promise<T>): Promise<T> =>
    withTenantSchema(schemaName, (tenantDb) =>
      run(
        new SchoolIdentityService(new SchoolIdentityRepository(tenantDb), storage, {
          warn: (obj, msg) => app.log.warn(obj, msg),
        })
      )
    );

  app.get(`${BASE}/identity`, guard, async (request, reply) => {
    try {
      return reply.send(await withService(request.claims!.schemaName, (s) => s.getIdentity(request.claims!.schemaName)));
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post(`${BASE}/image-preview`, guard, async (request, reply) => {
    try {
      const query = previewQuerySchema.parse(request.query ?? {});
      const upload = await readUpload(request);
      const preview = await withService(request.claims!.schemaName, (s) =>
        s.preview(query.kind, upload.buffer, query.removeWhite === 'true')
      );
      return sendImage(reply, preview, {
        'X-Source-Width': String(preview.sourceWidth),
        'X-Source-Height': String(preview.sourceHeight),
        'X-Source-Type': preview.sourceType,
      });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.put(`${BASE}/seal`, guard, async (request, reply) => {
    try {
      const { schemaName } = request.claims!;
      const query = saveSealQuerySchema.parse(request.query ?? {});
      const upload = await readUpload(request);
      return reply.send(
        await withService(schemaName, (s) =>
          s.saveSeal(schemaName, { ...upload, removeWhite: query.removeWhite === 'true' })
        )
      );
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.patch(`${BASE}/seal/background`, guard, async (request, reply) => {
    try {
      const { schemaName } = request.claims!;
      const body = backgroundBodySchema.parse(request.body ?? {});
      return reply.send(await withService(schemaName, (s) => s.setSealBackground(schemaName, body.removeWhite)));
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.delete(`${BASE}/seal`, guard, async (request, reply) => {
    try {
      const { schemaName } = request.claims!;
      return reply.send(await withService(schemaName, (s) => s.deleteSeal(schemaName)));
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get(`${BASE}/seal/image`, guard, async (request, reply) => {
    try {
      const { schemaName } = request.claims!;
      const query = imageQuerySchema.parse(request.query ?? {});
      return sendImage(reply, await withService(schemaName, (s) => s.readSeal(schemaName, query.variant)));
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get(`${BASE}/seal/legacy/:kind/image`, guard, async (request, reply) => {
    try {
      const { schemaName } = request.claims!;
      const params = legacyParamsSchema.parse(request.params);
      return sendImage(reply, await withService(schemaName, (s) => s.readLegacySeal(schemaName, params.kind)));
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.delete(`${BASE}/seal/legacy/:kind`, guard, async (request, reply) => {
    try {
      const { schemaName } = request.claims!;
      const params = legacyParamsSchema.parse(request.params);
      return reply.send(await withService(schemaName, (s) => s.deleteLegacySeal(schemaName, params.kind)));
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post(`${BASE}/logo`, guard, async (request, reply) => {
    try {
      const { schemaName } = request.claims!;
      const upload = await readUpload(request);
      const identity = await withService(schemaName, (s) => s.saveLogo(schemaName, upload));
      return reply.send({ ...identity, logoUrl: identity.logo?.url ?? null });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post(`${BASE}/logo/from-url`, guard, async (request, reply) => {
    try {
      const { schemaName } = request.claims!;
      const body = logoFromUrlBodySchema.parse(request.body ?? {});
      const identity = await withService(schemaName, (s) => s.saveLogoFromUrl(schemaName, body.url));
      return reply.send({ ...identity, logoUrl: identity.logo?.url ?? null });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.delete(`${BASE}/logo`, guard, async (request, reply) => {
    try {
      const { schemaName } = request.claims!;
      return reply.send(await withService(schemaName, (s) => s.deleteLogo(schemaName)));
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
}
