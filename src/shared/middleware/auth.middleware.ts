import type { FastifyReply, FastifyRequest } from 'fastify';

import { verifyAccessToken, type AccessTokenClaims } from '../../modules/auth/auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    claims?: AccessTokenClaims;
  }
}

const DIRECTOR_SECRETARY_ROLES = new Set(['director', 'secretary']);
const TEACHER_DIRECTOR_SECRETARY_ROLES = new Set(['teacher', 'director', 'secretary']);

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

export const authenticateRequest = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  request.user = null;
  request.auth = undefined;
  request.claims = undefined;

  try {
    const token = extractBearerToken(request);
    const claims = await verifyAccessToken(token);
    request.claims = claims;
    request.auth = claims;
    request.user = {
      userId: claims.sub,
      schemaName: claims.schemaName,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid access token';
    if (message === 'Missing Authorization header' || message === 'Invalid Authorization header') {
      unauthorized(reply, message);
      return;
    }

    unauthorized(reply, 'Invalid access token');
    return;
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

  if (!DIRECTOR_SECRETARY_ROLES.has(claims.role)) {
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

  if (!TEACHER_DIRECTOR_SECRETARY_ROLES.has(claims.role)) {
    forbidden(reply, 'Forbidden');
    return;
  }

  request.claims = claims;
};
