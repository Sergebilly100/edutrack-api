import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requireDirectorOrSecretary } from '../../shared/middleware/auth.middleware.js';

import {
  DocumentsModuleError,
  buildDocumentsService,
} from './documents.service.js';

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const entityParamsSchema = z.object({
  entityType: z.enum(['teacher', 'student']),
  entityId: z.string().regex(UUID_REGEX),
});

const documentParamsSchema = z.object({
  id: z.string().regex(UUID_REGEX),
});

type UploadPayload = {
  type: string;
  name: string;
  fileName: string;
  contentType: string;
  fileBuffer: Buffer;
};

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
};

const resolveBaseUrl = (request: FastifyRequest): string => {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }

  const host = request.headers.host;
  if (!host) {
    return 'http://localhost:3000';
  }

  return `${request.protocol}://${host}`;
};

const hasEntityPermission = (
  request: FastifyRequest
): boolean => {
  const role = request.claims?.role;

  if (role === 'director') {
    return true;
  }

  if (role === 'secretary') {
    return false;
  }

  return false;
};

const ensureDocumentsPermission = (
  request: FastifyRequest,
  reply: FastifyReply,
  entityType: 'teacher' | 'student'
): boolean => {
  if (hasEntityPermission(request)) {
    return true;
  }

  const permissionKey = entityType === 'teacher' ? 'teachers.documents' : 'students.documents';

  void reply.code(403).send({
    error: `Permission ${permissionKey} required`,
    code: 'FORBIDDEN',
    statusCode: 403,
  });

  return false;
};

const readUpload = async (request: FastifyRequest): Promise<UploadPayload> => {
  let fileName: string | null = null;
  let contentType: string | null = null;
  let fileBuffer: Buffer | null = null;
  let type = '';
  let name = '';

  const parts = request.parts({
    limits: {
      fileSize: MAX_UPLOAD_SIZE_BYTES,
      files: 1,
      fields: 20,
    },
  });

  for await (const part of parts) {
    if (part.type === 'file') {
      if (fileBuffer) {
        throw new DocumentsModuleError('Only one file is allowed', 400, 'DOCUMENT_MULTIPLE_FILES');
      }

      fileName = normalizeString(part.filename);
      contentType = part.mimetype;

      const buffer = await part.toBuffer();
      if (part.file.truncated || buffer.length > MAX_UPLOAD_SIZE_BYTES) {
        throw new DocumentsModuleError('File exceeds 10MB limit', 413, 'DOCUMENT_FILE_TOO_LARGE');
      }

      fileBuffer = buffer;
      continue;
    }

    if (part.fieldname === 'type') {
      type = normalizeString(part.value);
      continue;
    }

    if (part.fieldname === 'name') {
      name = normalizeString(part.value);
      continue;
    }
  }

  if (!fileBuffer || !fileName || !contentType) {
    throw new DocumentsModuleError('File is required', 400, 'DOCUMENT_FILE_REQUIRED');
  }

  if (fileBuffer.length === 0) {
    throw new DocumentsModuleError('File is empty', 400, 'DOCUMENT_FILE_EMPTY');
  }

  if (!type) {
    throw new DocumentsModuleError('Field "type" is required', 400, 'DOCUMENT_TYPE_REQUIRED');
  }

  if (!name) {
    throw new DocumentsModuleError('Field "name" is required', 400, 'DOCUMENT_NAME_REQUIRED');
  }

  return {
    type,
    name,
    fileName,
    contentType,
    fileBuffer,
  };
};

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  if (error instanceof DocumentsModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  if (error instanceof Error && error.message.includes('File too large')) {
    return reply.code(413).send({
      error: 'File exceeds 10MB limit',
      code: 'DOCUMENT_FILE_TOO_LARGE',
      statusCode: 413,
    });
  }

  return reply.code(500).send({
    error: 'Unexpected error',
    code: 'INTERNAL_SERVER_ERROR',
    statusCode: 500,
  });
};

export default async function documentsController(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/documents/:entityType/:entityId', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = entityParamsSchema.parse(request.params ?? {});

      if (!ensureDocumentsPermission(request, reply, params.entityType)) {
        return;
      }

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildDocumentsService(tenantDb);
        return service.listDocuments({
          entityType: params.entityType,
          entityId: params.entityId,
          baseUrl: resolveBaseUrl(request),
        });
      });

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/documents/:entityType/:entityId', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = entityParamsSchema.parse(request.params ?? {});

      if (!ensureDocumentsPermission(request, reply, params.entityType)) {
        return;
      }

      const upload = await readUpload(request);

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildDocumentsService(tenantDb);
        return service.uploadDocument({
          schemaName: claims.schemaName,
          uploadedBy: claims.sub,
          entityType: params.entityType,
          entityId: params.entityId,
          type: upload.type,
          name: upload.name,
          fileName: upload.fileName,
          fileBuffer: upload.fileBuffer,
          contentType: upload.contentType,
          baseUrl: resolveBaseUrl(request),
        });
      });

      return reply.code(201).send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/documents/:id/download', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = documentParamsSchema.parse(request.params ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildDocumentsService(tenantDb);

        const metadata = await service.getDocumentMetadata(params.id);
        if (!ensureDocumentsPermission(request, reply, metadata.entityType)) {
          return null;
        }

        return service.createDownloadUrl({
          schemaName: claims.schemaName,
          documentId: params.id,
          adminId: claims.sub,
          ipAddress: request.ip,
          baseUrl: resolveBaseUrl(request),
        });
      });

      if (!result) {
        return;
      }

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.delete('/api/v1/documents/:id', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = documentParamsSchema.parse(request.params ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildDocumentsService(tenantDb);

        const metadata = await service.getDocumentMetadata(params.id);
        if (!ensureDocumentsPermission(request, reply, metadata.entityType)) {
          return null;
        }

        return service.deleteDocument({
          documentId: params.id,
        });
      });

      if (!result) {
        return;
      }

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });
}
