import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';

import { withTenantSchema } from '../database/db.js';
import type { PermissionKey } from '../types/index.js';
import {
  PermissionsRepository,
} from '../../modules/permissions/permissions.repository.js';
import { resolveEffectivePermissions } from '../../modules/permissions/permissions.service.js';
import { verifyAccessToken, type AccessTokenClaims } from '../../modules/auth/auth.service.js';
import { getRevokeAt, TokenRevocationUnavailableError } from '../auth/token-version.js';

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

export class ParentAccessError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ParentAccessError';
  }
}

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

  // Si le mot de passe doit être changé, on ne laisse passer que les routes
  // strictement nécessaires : changement de mdp, profil courant, déconnexion, refresh.
  if (claims.mustChangePassword) {
    const url = request.url;
    const method = request.method.toUpperCase();
    const isChangePassword = method === 'POST' && url.startsWith('/api/v1/auth/change-password');
    const isMe = method === 'GET' && url.startsWith('/api/v1/auth/me');
    const isLogout = method === 'POST' && url.startsWith('/api/v1/auth/logout');
    const isRefresh = method === 'POST' && url.startsWith('/api/v1/auth/refresh');
    if (!isChangePassword && !isMe && !isLogout && !isRefresh) {
      reply.code(403).send({
        error: 'Password change required',
        code: 'PASSWORD_CHANGE_REQUIRED',
        statusCode: 403,
      });
      return;
    }
  }

  // Reject tokens issued before the last password reset for this user.
  // Fail-closed: if Redis is unreachable we'd rather return 503 than honor a
  // potentially-revoked token (a stolen access token must not survive a Redis outage).
  const iat = typeof (claims as Record<string, unknown>).iat === 'number'
    ? (claims as Record<string, unknown>).iat as number
    : 0;
  let revokeAt = 0;
  try {
    revokeAt = await getRevokeAt(claims.schemaName, claims.sub);
  } catch (error) {
    if (error instanceof TokenRevocationUnavailableError) {
      request.log.error(
        { schema: claims.schemaName, userId: claims.sub },
        '[auth] redis_revocation_unavailable'
      );
      reply.code(503).send({
        error: 'Authentication temporarily unavailable',
        code: 'AUTH_TEMPORARILY_UNAVAILABLE',
        statusCode: 503,
      });
      return;
    }
    throw error;
  }
  if (revokeAt > 0 && iat < revokeAt) {
    unauthorized(reply, 'Session invalidée, veuillez vous reconnecter');
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

export const requireTeacherOrDirector = async (
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

  if (claims.role !== 'teacher' && claims.role !== 'director') {
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

export const requireParent = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  request.user = null;
  request.auth = undefined;
  request.claims = undefined;
  request.permissions = undefined;
  request.parentId = undefined;
  request.allowedStudentIds = undefined;

  let claims: AccessTokenClaims;
  try {
    const token = extractBearerToken(request);
    claims = await verifyAccessToken(token);
  } catch {
    unauthorized(reply, 'Invalid access token');
    return;
  }

  if (claims.role !== 'parent') {
    forbidden(reply, 'Forbidden');
    return;
  }

  const allowsPasswordChangeRoute =
    request.method.toUpperCase() === 'POST' &&
    request.url.startsWith('/api/v1/parent/auth/change-password');
  if (!allowsPasswordChangeRoute) {
    const result = await withTenantSchema(claims.schemaName, async (tenantDb) =>
      tenantDb.execute<{ must_change_password: boolean }>(sql`
        SELECT must_change_password
        FROM parents
        WHERE id = ${claims.sub}::uuid
        LIMIT 1
      `)
    );
    const mustChangePassword = result.rows[0]?.must_change_password ?? false;
    if (mustChangePassword) {
      reply.code(403).send({
        error: 'Password change required',
        code: 'PASSWORD_CHANGE_REQUIRED',
        statusCode: 403,
      });
      return;
    }
  }

  const allowedStudentIds = Array.isArray(claims.studentIds) ? claims.studentIds : [];

  request.claims = claims;
  request.auth = claims;
  request.user = {
    userId: claims.sub,
    schemaName: claims.schemaName,
  };
  request.parentId = claims.sub;
  request.allowedStudentIds = allowedStudentIds;
};

export const checkStudentAccess = (request: FastifyRequest, studentId: string): void => {
  const allowed = request.allowedStudentIds ?? [];
  if (!allowed.includes(studentId)) {
    throw new ParentAccessError(403, 'STUDENT_ACCESS_DENIED', 'Student access denied');
  }
};
