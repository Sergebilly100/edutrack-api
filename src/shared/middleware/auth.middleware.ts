import type { FastifyReply, FastifyRequest } from 'fastify';

import { withTenantSchema } from '../database/db.js';
import type { PermissionKey } from '../types/index.js';
import {
  PermissionsRepository,
} from '../../modules/permissions/permissions.repository.js';
import { resolveEffectivePermissions } from '../../modules/permissions/permissions.service.js';
import { verifyAccessToken, type AccessTokenClaims } from '../../modules/auth/auth.service.js';

const DIRECTOR_STAFF_ROLES = new Set(['director', 'staff']);
const TEACHER_DIRECTOR_STAFF_ROLES = new Set(['teacher', 'director', 'staff']);
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const extractBearerToken = (request: FastifyRequest): string => {
  const authorization = request.headers.authorization;
  if (!authorization) {
    throw new Error('Missing Authorization header');
  }

  const [scheme, token] = authorization.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new Error('Invalid Authorization header');
  }

  return token;
};

const unauthorized = (reply: FastifyReply, message: string): FastifyReply => {
  return reply.code(401).send({
    error: message,
    code: 'UNAUTHORIZED',
    statusCode: 401,
  });
};

const forbidden = (reply: FastifyReply, message: string): FastifyReply => {
  return reply.code(403).send({
    error: message,
    code: 'FORBIDDEN',
    statusCode: 403,
  });
};

const internalError = (reply: FastifyReply, message = 'Internal server error'): FastifyReply => {
  return reply.code(500).send({
    error: message,
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export const authenticateRequest = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  request.user = null;
  request.auth = undefined;
  request.claims = undefined;
  request.permissions = undefined;

  let claims: AccessTokenClaims;

  try {
    const token = extractBearerToken(request);
    claims = await verifyAccessToken(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid access token';
    if (message === 'Missing Authorization header' || message === 'Invalid Authorization header') {
      unauthorized(reply, message);
      return;
    }

    unauthorized(reply, 'Invalid access token');
    return;
  }

  if (claims.readOnly && !READ_ONLY_METHODS.has(request.method.toUpperCase())) {
    forbidden(reply, 'Session en lecture seule');
    return;
  }

  try {
    const permissions = await withTenantSchema(claims.schemaName, async (tenantDb) => {
      const repository = new PermissionsRepository(tenantDb);
      return resolveEffectivePermissions(repository, claims);
    });

    request.claims = claims;
    request.auth = claims;
    request.user = {
      userId: claims.sub,
      schemaName: claims.schemaName,
    };
    request.permissions = new Set<PermissionKey>(permissions);
  } catch (error) {
    request.log.error(
      { err: error instanceof Error ? error.message : 'unknown error' },
      '[auth] failed to resolve permissions'
    );
    internalError(reply, 'Failed to resolve permissions');
  }
};

export const requireRole =
  (role: AccessTokenClaims['role']) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.auth) {
      void unauthorized(reply, 'Unauthorized');
      return;
    }

    if (request.auth.role !== role) {
      forbidden(reply, `Role ${role} required`);
      return;
    }
  };

export const requireDirectorOrSecretary = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  await authenticateRequest(request, reply);
  if (reply.sent) {
    return;
  }

  const claims = request.auth;
  if (!claims) {
    unauthorized(reply, 'Unauthorized');
    return;
  }

  if (!DIRECTOR_STAFF_ROLES.has(claims.role)) {
    forbidden(reply, 'Forbidden');
    return;
  }

  request.claims = claims;
};

export const requireTeacher = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  await authenticateRequest(request, reply);
  if (reply.sent) {
    return;
  }

  const claims = request.auth;
  if (!claims) {
    unauthorized(reply, 'Unauthorized');
    return;
  }

  if (claims.role !== 'teacher') {
    forbidden(reply, 'Forbidden');
    return;
  }

  request.claims = claims;
};

export const requireTeacherOrDirectorOrSecretary = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  await authenticateRequest(request, reply);
  if (reply.sent) {
    return;
  }

  const claims = request.auth;
  if (!claims) {
    unauthorized(reply, 'Unauthorized');
    return;
  }

  if (!TEACHER_DIRECTOR_STAFF_ROLES.has(claims.role)) {
    forbidden(reply, 'Forbidden');
    return;
  }

  request.claims = claims;
};

export const requireDirector = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  await authenticateRequest(request, reply);
  if (reply.sent) {
    return;
  }

  const claims = request.auth;
  if (!claims) {
    unauthorized(reply, 'Unauthorized');
    return;
  }

  if (claims.role !== 'director') {
    forbidden(reply, 'Forbidden');
    return;
  }

  request.claims = claims;
};

export const requirePermission =
  (permission: PermissionKey) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authenticateRequest(request, reply);
    if (reply.sent) {
      return;
    }

    if (!request.permissions?.has(permission)) {
      forbidden(reply, `Permission ${permission} required`);
      return;
    }
  };
