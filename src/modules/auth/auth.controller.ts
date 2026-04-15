import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { findUserProfileById } from './auth.repository.js';
import {
  buildClaims,
  getMe,
  login,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './auth.service.js';

const loginSchema = z.object({
  identifier: z.string().trim().min(4).max(255),
  password: z.string().min(1),
});

const SCHEMA_NAME_REGEX = /^[a-z][a-z0-9_]{2,63}$/;

const getSchemaName = (request: FastifyRequest): string => {
  const headerValue = request.headers['x-tenant-schema'];
  if (typeof headerValue !== 'string' || headerValue.trim().length === 0) {
    throw new Error('Missing x-tenant-schema header');
  }

  const schema = headerValue.trim();
  if (!SCHEMA_NAME_REGEX.test(schema)) {
    throw new Error('Invalid tenant schema');
  }

  return schema;
};

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

const parseCookies = (rawCookieHeader: string | undefined): Record<string, string> => {
  if (!rawCookieHeader) {
    return {};
  }

  return rawCookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, cookiePart) => {
      const separatorIndex = cookiePart.indexOf('=');
      if (separatorIndex < 1) {
        return acc;
      }

      const key = cookiePart.slice(0, separatorIndex);
      const value = cookiePart.slice(separatorIndex + 1);
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
};

const setRefreshCookie = (reply: FastifyReply, refreshToken: string): void => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `refresh_token=${encodeURIComponent(refreshToken)}; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=2592000${secure}`;
  reply.header('Set-Cookie', cookie);
};

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  const isUnauthorized =
    message === 'Invalid credentials' ||
    message === 'Missing Authorization header' ||
    message === 'Invalid Authorization header' ||
    message === 'Missing refresh token' ||
    message === 'Invalid refresh token' ||
    message === 'Invalid access token';

  const statusCode = isUnauthorized ? 401 : 400;

  return reply.code(statusCode).send({
    error: message,
    code: statusCode === 401 ? 'UNAUTHORIZED' : 'BAD_REQUEST',
    statusCode,
  });
};

export default async function authController(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/auth/login/teacher', async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);
      const schemaName = getSchemaName(request);

      const result = await withTenantSchema(schemaName, (tenantDb) =>
        login(tenantDb, {
          identifier: body.identifier,
          password: body.password,
          schemaName,
        })
      );

      const refreshToken = await signRefreshToken(result.user.id, schemaName);
      setRefreshCookie(reply, refreshToken);

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    try {
      const token = extractBearerToken(request);
      const claims = await verifyAccessToken(token);

      const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
        getMe(tenantDb, claims.sub)
      );

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    try {
      const cookies = parseCookies(request.headers.cookie);
      const refreshToken = cookies.refresh_token;
      if (!refreshToken) {
        throw new Error('Missing refresh token');
      }

      const payload = await verifyRefreshToken(refreshToken);

      const profile = await withTenantSchema(payload.schemaName, (db) =>
        findUserProfileById(db, payload.sub)
      );

      if (!profile || !profile.isActive) {
        throw new Error('Invalid credentials');
      }

      const claims = buildClaims(profile, payload.schemaName);
      const accessToken = await signAccessToken(claims);

      return reply.send({
        accessToken,
        tokenType: 'Bearer',
        expiresIn: process.env.JWT_EXPIRY ?? '15m',
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });
}
