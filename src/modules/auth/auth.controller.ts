import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { z, ZodError } from 'zod';

import { db, withTenantSchema } from '../../shared/database/db.js';
import { getRowsUntyped as getRows } from '../../shared/utils/db-helpers.js';
import { cached } from '../../shared/cache/redis-cache.js';
import {
  assertParentPortalEnabled,
  changePassword,
  getMe,
  login,
  listUserSessions,
  logout,
  registerRefreshToken,
  refreshAccessToken,
  revokeUserSession,
  signAccessToken,
  signRefreshToken,
  updateMe,
  verifyAccessToken,
  verifyRefreshToken,
} from './auth.service.js';
import { buildParentPortalService, ParentPortalError } from '../parent-portal/parent-portal.service.js';
import { parentLoginSchema } from '../parent-portal/parent-portal.types.js';
import {
  clearFailedLogins,
  isLoginLocked,
  recordFailedLogin,
} from '../../shared/auth/login-lockout.js';

const loginSchema = z.object({
  identifier: z.string().trim().min(4).max(255),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1).optional(),
});
const sessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

const strongPasswordSchema = z
  .string()
  .min(8)
  .regex(/[A-Z]/, 'Le mot de passe doit contenir au moins une majuscule')
  .regex(/[0-9]/, 'Le mot de passe doit contenir au moins un chiffre');

const changePasswordSchema = z
  .object({
    current_password: z.string().trim().min(1).optional(),
    new_password: strongPasswordSchema.optional(),
    currentPassword: z.string().trim().min(1).optional(),
    newPassword: strongPasswordSchema.optional(),
    confirmPassword: z.string().min(1).optional(),
  })
  .superRefine((body, ctx) => {
    const currentPassword = body.current_password ?? body.currentPassword;
    const newPassword = body.new_password ?? body.newPassword;

    if (!currentPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['current_password'],
        message: 'Le mot de passe actuel est requis',
      });
    }

    if (!newPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['new_password'],
        message: 'Le nouveau mot de passe est requis',
      });
    }

    if (body.confirmPassword !== undefined && newPassword && body.confirmPassword !== newPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: 'Les mots de passe ne correspondent pas',
      });
    }
  });

const updateMeSchema = z
  .object({
    name: z.string().trim().min(2).max(255).optional(),
    phone: z.string().trim().min(6).max(20).nullable().optional(),
    profilePhotoUrl: z.string().trim().max(2_000_000).nullable().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.phone !== undefined ||
      body.profilePhotoUrl !== undefined,
    {
      message: 'At least one field must be provided',
    }
  );

const SCHEMA_NAME_REGEX = /^[a-z][a-z0-9_]{2,63}$/;
const SUBDOMAIN_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_LOCAL_SCHEMA =
  (process.env.AUTH_DEFAULT_TENANT_SCHEMA ?? 'school_sainte_marie').trim();
const ADMIN_SCHEMA =
  (process.env.AUTH_ADMIN_SCHEMA ?? DEFAULT_LOCAL_SCHEMA).trim();
const LOGIN_RATE_LIMIT_MAX = (() => {
  const parsed = Number.parseInt(process.env.AUTH_LOGIN_RATE_LIMIT_MAX ?? '', 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return process.env.NODE_ENV === 'production' ? 10 : 200;
})();
// LOGIN_RATE_LIMITE_WINDOW correspond à la durée pendant laquelle les tentatives de connexion sont comptabilisées pour le verrouillage du compte. 
// Par exemple, '1 minute' signifie que si un utilisateur dépasse le nombre maximum de tentatives de connexion échouées (défini par LOGIN_RATE_LIMIT_MAX) en une minute, son compte sera verrouillé pendant une durée déterminée (généralement 15 minutes ou plus). Vous pouvez ajuster cette valeur en fonction de vos besoins en matière de sécurité et d'expérience utilisateur.
// la durée de verrouillage du compte est definie dans le module login-lockout.js, dans la fonction recordFailedLogin
const LOGIN_RATE_LIMIT_WINDOW = process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW ?? '1 minute';

const extractHostname = (request: FastifyRequest): string | null => {
  const host = typeof request.headers.host === 'string' ? request.headers.host : '';
  if (!host) {
    return null;
  }

  const noPort = host.split(':')[0]?.trim().toLowerCase() ?? '';
  return noPort.length > 0 ? noPort : null;
};

// Extrait le premier label d'un hostname s'il correspond à un subdomain valide pour notre usage (tenant), sinon retourne null.
const parseSubdomain = (hostname: string): string | null => {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return null;
  }

  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 3) {
    return null;
  }

  const firstLabel = labels[0] ?? '';
  if (!SUBDOMAIN_REGEX.test(firstLabel) || firstLabel === 'www' || firstLabel === 'admin') {
    return null;
  }

  return firstLabel;
};

const resolveSchemaBySubdomain = async (subdomain: string): Promise<string | null> => {
  return cached(`tenant:subdomain:${subdomain}`, 300, async () => {
    const result = await db.execute<{ schema_name: string }>(sql`
      SELECT schema_name
      FROM public.tenants
      WHERE subdomain = ${subdomain}
      LIMIT 1
    `);

    return getRows<{ schema_name: string }>(result)[0]?.schema_name ?? null;
  });
};

const resolveTenantBySchema = async (
  schemaName: string
): Promise<{ id: string; schema_name: string } | null> => {
  return cached(`tenant:schema:${schemaName}`, 300, async () => {
    const result = await db.execute<{ id: string; schema_name: string }>(sql`
      SELECT id::text, schema_name
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);

    return getRows<{ id: string; schema_name: string }>(result)[0] ?? null;
  });
};

type TenantStatusRow = {
  id: string;
  status: string;
  trial_ends_at: string | null;
};

const resolveTenantStatusBySchema = async (
  schemaName: string
): Promise<TenantStatusRow | null> => {
  try {
    const result = await db.execute<TenantStatusRow>(sql`
      SELECT id::text, status::text, trial_ends_at::text
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);
    return getRows<TenantStatusRow>(result)[0] ?? null;
  } catch {
    return null;
  }
};

const getSchemaName = async (request: FastifyRequest): Promise<string> => {
  const headerValue = request.headers['x-tenant-schema'];
  if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
    const schema = headerValue.trim();
    if (!SCHEMA_NAME_REGEX.test(schema)) {
      throw new Error('Invalid tenant schema');
    }
    return schema;
  }

  const subdomainHeader = request.headers['x-tenant-subdomain'];
  if (typeof subdomainHeader === 'string' && subdomainHeader.trim().length > 0) {
    const subdomain = subdomainHeader.trim().toLowerCase();
    if (!SUBDOMAIN_REGEX.test(subdomain)) {
      throw new Error('Invalid tenant subdomain');
    }
    const schema = await resolveSchemaBySubdomain(subdomain);
    if (!schema) {
      throw new Error('Tenant not found');
    }
    return schema;
  }

  const hostname = extractHostname(request);
  if (hostname) {
    const subdomain = parseSubdomain(hostname);
    if (subdomain) {
      const schema = await resolveSchemaBySubdomain(subdomain);
      if (!schema) {
        throw new Error('Tenant not found');
      }
      return schema;
    }

    // Support de l'hôte "localhost" pour le développement local : on retourne un schéma par défaut si défini et valide.
    const isLocalHost =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (isLocalHost && SCHEMA_NAME_REGEX.test(DEFAULT_LOCAL_SCHEMA)) {
      return DEFAULT_LOCAL_SCHEMA;
    }
  }

  throw new Error('Missing tenant context');
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

const getClientContext = (
  request: FastifyRequest
): { userAgent: string | null; ipAddress: string | null } => {
  const rawUserAgent = request.headers['user-agent'];
  const userAgent =
    typeof rawUserAgent === 'string' && rawUserAgent.trim().length > 0
      ? rawUserAgent.trim().slice(0, 512)
      : null;
  const forwardedFor = request.headers['x-forwarded-for'];
  const ipFromForwarded =
    typeof forwardedFor === 'string'
      ? forwardedFor.split(',')[0]?.trim() ?? null
      : null;
  const ipAddress = ipFromForwarded || request.ip || null;
  return { userAgent, ipAddress };
};

const setRefreshCookie = (reply: FastifyReply, refreshToken: string): void => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `refresh_token=${encodeURIComponent(refreshToken)}; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=2592000${secure}`;
  reply.header('Set-Cookie', cookie);
};

const clearRefreshCookie = (reply: FastifyReply): void => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `refresh_token=; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=0${secure}`;
  reply.header('Set-Cookie', cookie);
};

const assertWritableSession = (request: FastifyRequest, claims: { readOnly?: boolean }): void => {
  if (claims.readOnly && request.method.toUpperCase() !== 'GET') {
    throw new Error('Session en lecture seule');
  }
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
    message === 'Only super admin can sign in from this domain' ||
    message === 'Missing Authorization header' ||
    message === 'Invalid Authorization header' ||
    message === 'Missing refresh token' ||
    message === 'Invalid refresh token' ||
    message === 'Invalid access token' ||
    message === 'Current password is incorrect' ||
    (error instanceof Error && error.name === 'JWTExpired');
  const isForbidden =
    message === 'Modification de mot de passe non autorisée pour ce rôle' ||
    message === 'Session en lecture seule';
  const isInternal = message === 'Session initialization failed';
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  const constraint =
    typeof error === 'object' && error !== null && 'constraint' in error
      ? String((error as { constraint: unknown }).constraint)
      : '';
  const isConflict =
    code === '23505' &&
    (constraint.includes('users_email_unique') || constraint.includes('users_phone_unique'));

  const statusCode = isUnauthorized
    ? 401
    : isForbidden
      ? 403
      : isConflict
        ? 409
        : isInternal
          ? 500
          : 400;
  const errorCode =
    statusCode === 401
      ? 'UNAUTHORIZED'
      : statusCode === 403
        ? 'FORBIDDEN'
        : statusCode === 409
          ? 'CONFLICT'
          : statusCode === 500
            ? 'INTERNAL_ERROR'
          : 'BAD_REQUEST';
  const finalMessage =
    statusCode === 409
      ? constraint.includes('users_email_unique')
        ? 'Cet email est déjà utilisé'
        : 'Ce numéro est déjà utilisé'
      : message;

  return reply.code(statusCode).send({
    error: finalMessage,
    code: errorCode,
    statusCode,
  });
};

export default async function authController(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/auth/login/teacher',
    {
      config: {
        rateLimit: {
          max: LOGIN_RATE_LIMIT_MAX,
          timeWindow: LOGIN_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      try {
        const body = loginSchema.parse(request.body);
        const schemaName = await getSchemaName(request);

        const lockState = await isLoginLocked(schemaName, body.identifier);
        if (lockState.locked) {
          return reply.code(429).send({
            error: 'Trop de tentatives échouées. Réessayez plus tard.',
            code: 'ACCOUNT_LOCKED',
            statusCode: 429,
            retryAfterSeconds: lockState.remainingSeconds,
          });
        }

        let result;
        try {
          result = await withTenantSchema(schemaName, (tenantDb) =>
            login(tenantDb, {
              identifier: body.identifier,
              password: body.password,
              schemaName,
            })
          );
        } catch (loginErr) {
          // Seul un vrai échec d'identifiant doit alimenter le compteur de lockout.
          // Les erreurs techniques (SQL, réseau, Keycloak indispo…) remontent
          // telles quelles en 500 et ne pénalisent pas l'utilisateur.
          const isCredentialsError =
            loginErr instanceof Error && loginErr.message === 'Invalid credentials';
          if (!isCredentialsError) {
            throw loginErr;
          }
          const { lockedSeconds } = await recordFailedLogin(schemaName, body.identifier);
          if (lockedSeconds > 0) {
            return reply.code(429).send({
              error: 'Trop de tentatives échouées. Réessayez plus tard.',
              code: 'ACCOUNT_LOCKED',
              statusCode: 429,
              retryAfterSeconds: lockedSeconds,
            });
          }
          throw loginErr;
        }

        if (result.user.role === 'super_admin') {
          return reply.code(403).send({
            error: 'Utilisez /api/v1/auth/login/admin pour vous connecter en tant que super administrateur.',
            code: 'USE_ADMIN_LOGIN',
            statusCode: 403,
          });
        }

        await clearFailedLogins(schemaName, body.identifier);

        const refreshToken = await signRefreshToken(result.user.id, schemaName);
        try {
          const context = getClientContext(request);
          await withTenantSchema(schemaName, (tenantDb) =>
            registerRefreshToken(tenantDb, refreshToken, context)
          );
        } catch (error) {
          request.log.error(
            { err: error instanceof Error ? error.message : 'unknown error', schemaName },
            '[auth] unable to persist refresh token at login'
          );
          throw new Error('Session initialization failed');
        }
        setRefreshCookie(reply, refreshToken);

        return reply.send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    '/api/v1/auth/login/admin',
    {
      config: {
        rateLimit: {
          max: LOGIN_RATE_LIMIT_MAX,
          timeWindow: LOGIN_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      try {
        const body = loginSchema.parse(request.body);

        const lockState = await isLoginLocked(ADMIN_SCHEMA, body.identifier);
        if (lockState.locked) {
          return reply.code(429).send({
            error: 'Trop de tentatives échouées. Réessayez plus tard.',
            code: 'ACCOUNT_LOCKED',
            statusCode: 429,
            retryAfterSeconds: lockState.remainingSeconds,
          });
        }

        let result;
        try {
          result = await withTenantSchema(ADMIN_SCHEMA, (tenantDb) =>
            login(tenantDb, {
              identifier: body.identifier,
              password: body.password,
              schemaName: ADMIN_SCHEMA,
            })
          );
        } catch (loginErr) {
          const isCredentialsError =
            loginErr instanceof Error && loginErr.message === 'Invalid credentials';
          if (!isCredentialsError) {
            throw loginErr;
          }
          const { lockedSeconds } = await recordFailedLogin(ADMIN_SCHEMA, body.identifier);
          if (lockedSeconds > 0) {
            return reply.code(429).send({
              error: 'Trop de tentatives échouées. Réessayez plus tard.',
              code: 'ACCOUNT_LOCKED',
              statusCode: 429,
              retryAfterSeconds: lockedSeconds,
            });
          }
          throw loginErr;
        }

        if (result.user.role !== 'super_admin') {
          return reply.code(403).send({
            error: 'Accès réservé aux super administrateurs.',
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }

        await clearFailedLogins(ADMIN_SCHEMA, body.identifier);

        const refreshToken = await signRefreshToken(result.user.id, ADMIN_SCHEMA);
        try {
          const context = getClientContext(request);
          await withTenantSchema(ADMIN_SCHEMA, (tenantDb) =>
            registerRefreshToken(tenantDb, refreshToken, context)
          );
        } catch (error) {
          request.log.error(
            { err: error instanceof Error ? error.message : 'unknown error', schemaName: ADMIN_SCHEMA },
            '[auth] unable to persist refresh token at admin login'
          );
          throw new Error('Session initialization failed');
        }
        setRefreshCookie(reply, refreshToken);

        return reply.send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    '/api/v1/auth/login/parent',
    {
      config: {
        rateLimit: {
          max: LOGIN_RATE_LIMIT_MAX,
          timeWindow: LOGIN_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      try {
        const body = parentLoginSchema.parse(request.body ?? {});
        const schemaName = await getSchemaName(request);
        const tenant = await resolveTenantBySchema(schemaName);
        if (!tenant) {
          throw new Error('Tenant not found');
        }

        await assertParentPortalEnabled(db, tenant.id);

        const lockState = await isLoginLocked(schemaName, body.phone);
        if (lockState.locked) {
          return reply.code(429).send({
            error: 'Trop de tentatives échouées. Réessayez plus tard.',
            code: 'ACCOUNT_LOCKED',
            statusCode: 429,
            retryAfterSeconds: lockState.remainingSeconds,
          });
        }

        let auth;
        try {
          auth = await withTenantSchema(schemaName, async (tenantDb) => {
            const service = buildParentPortalService(tenantDb);
            return service.loginParent({ phone: body.phone, password: body.password });
          });
        } catch (loginErr) {
          // Seul un vrai échec d'identifiant (phone/mot de passe incorrect)
          // doit alimenter le compteur de lockout. Les erreurs métier
          // (abonnement expiré, service indisponible) ou techniques (SQL, réseau)
          // ne pénalisent pas l'utilisateur.
          const isCredentialsError =
            loginErr instanceof ParentPortalError &&
            loginErr.code === 'UNAUTHORIZED' &&
            loginErr.message === 'Invalid credentials';
          if (!isCredentialsError) {
            throw loginErr;
          }
          const { lockedSeconds } = await recordFailedLogin(schemaName, body.phone);
          if (lockedSeconds > 0) {
            return reply.code(429).send({
              error: 'Trop de tentatives échouées. Réessayez plus tard.',
              code: 'ACCOUNT_LOCKED',
              statusCode: 429,
              retryAfterSeconds: lockedSeconds,
            });
          }
          throw loginErr;
        }

        await clearFailedLogins(schemaName, body.phone);

        const claims = {
          sub: auth.parentId,
          role: 'parent' as const,
          tenantId: tenant.id,
          schemaName,
          phone: auth.phone,
          fullName: auth.full_name,
          email: auth.email,
          studentIds: auth.studentIds,
          mustChangePassword: auth.mustChangePassword,
        };
        const accessToken = await signAccessToken(claims);
        const refreshToken = await signRefreshToken(auth.parentId, schemaName);
        setRefreshCookie(reply, refreshToken);

        return reply.send({
          accessToken,
          tokenType: 'Bearer',
          expiresIn: process.env.JWT_EXPIRY ?? '15m',
          user: {
            id: auth.parentId,
            role: 'parent',
            phone: auth.phone,
            fullName: auth.full_name,
            email: auth.email,
            studentIds: auth.studentIds,
            mustChangePassword: auth.mustChangePassword,
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'SERVICE_NOT_AVAILABLE') {
          return reply.code(403).send({
            error: 'SERVICE_NOT_AVAILABLE',
            code: 'SERVICE_NOT_AVAILABLE',
            statusCode: 403,
          });
        }
        if (error instanceof ParentPortalError) {
          return reply.code(error.statusCode).send({
            error: error.code === 'SUBSCRIPTION_EXPIRED' ? 'SUBSCRIPTION_EXPIRED' : error.message,
            message: error.code === 'SUBSCRIPTION_EXPIRED' ? error.message : undefined,
            code: error.code,
            statusCode: error.statusCode,
          });
        }
        return handleError(reply, error);
      }
    }
  );

  app.get('/api/v1/auth/me', async (request, reply) => {
    try {
      const token = extractBearerToken(request);
      const claims = await verifyAccessToken(token);

      const [result, tenant] = await Promise.all([
        withTenantSchema(claims.schemaName, (tenantDb) => getMe(tenantDb, claims.sub)),
        resolveTenantStatusBySchema(claims.schemaName),
      ]);

      return reply.send({
        ...result,
        tenant: tenant
          ? {
              id: tenant.id,
              status: tenant.status,
              trialEndsAt: tenant.trial_ends_at,
            }
          : null,
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post(
    '/api/v1/auth/refresh',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      try {
        const parsedBody = refreshSchema.parse(request.body ?? {});
        const cookies = parseCookies(request.headers.cookie);
        const refreshToken = cookies.refresh_token ?? parsedBody.refreshToken;
        if (!refreshToken) {
          throw new Error('Missing refresh token');
        }

        const payload = await verifyRefreshToken(refreshToken);
        const context = getClientContext(request);
        const result = await withTenantSchema(payload.schemaName, (tenantDb) =>
          refreshAccessToken(tenantDb, refreshToken, context)
        );
        if ('refreshToken' in result && typeof result.refreshToken === 'string') {
          setRefreshCookie(reply, result.refreshToken);
        }

        return reply.send({
          accessToken: result.accessToken,
          tokenType: result.tokenType,
          expiresIn: result.expiresIn,
        });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post('/api/v1/auth/logout', async (request, reply) => {
    try {
      const parsedBody = refreshSchema.parse(request.body ?? {});
      const cookies = parseCookies(request.headers.cookie);
      const refreshToken = cookies.refresh_token ?? parsedBody.refreshToken;

      if (refreshToken) {
        try {
          const payload = await verifyRefreshToken(refreshToken);
          await withTenantSchema(payload.schemaName, (tenantDb) => logout(tenantDb, refreshToken));
        } catch {
          // Keep logout idempotent even when token is malformed/expired.
        }
      }

      clearRefreshCookie(reply);
      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/auth/sessions', async (request, reply) => {
    try {
      const token = extractBearerToken(request);
      const claims = await verifyAccessToken(token);
      const cookies = parseCookies(request.headers.cookie);
      const currentRefreshToken = cookies.refresh_token;

      const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
        listUserSessions(tenantDb, { userId: claims.sub, currentRefreshToken })
      );

      return reply.send({ sessions: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.delete('/api/v1/auth/sessions/:sessionId', async (request, reply) => {
    try {
      const token = extractBearerToken(request);
      const claims = await verifyAccessToken(token);
      assertWritableSession(request, claims);
      const { sessionId } = sessionParamsSchema.parse(request.params);

      const revoked = await withTenantSchema(claims.schemaName, (tenantDb) =>
        revokeUserSession(tenantDb, { userId: claims.sub, sessionId })
      );

      return reply.send({ success: revoked });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post(
    '/api/v1/auth/change-password',
    {
      // Brute-force du mot de passe actuel : même budget que le login.
      config: {
        rateLimit: {
          max: LOGIN_RATE_LIMIT_MAX,
          timeWindow: LOGIN_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      try {
        const token = extractBearerToken(request);
        const claims = await verifyAccessToken(token);
        assertWritableSession(request, claims);
        const body = changePasswordSchema.parse(request.body);
        const currentPassword = body.current_password ?? body.currentPassword;
        const newPassword = body.new_password ?? body.newPassword;

        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          changePassword(tenantDb, {
            userId: claims.sub,
            currentPassword: currentPassword!,
            newPassword: newPassword!,
            schemaName: claims.schemaName,
          })
        );

        // changePassword a révoqué TOUTES les sessions (revoke_at + refresh tokens).
        // On réémet ici les credentials de la session courante pour qu'elle survive :
        // nouveau refresh cookie + accessToken frais renvoyé au front. Sans ça, le
        // client gardait un token invalidé → erreurs de chargement post-changement.
        const refreshToken = await signRefreshToken(claims.sub, claims.schemaName);
        try {
          const context = getClientContext(request);
          await withTenantSchema(claims.schemaName, (tenantDb) =>
            registerRefreshToken(tenantDb, refreshToken, context)
          );
        } catch (error) {
          request.log.error(
            { err: error instanceof Error ? error.message : 'unknown error', schemaName: claims.schemaName },
            '[auth] unable to persist refresh token after password change'
          );
          throw new Error('Session initialization failed');
        }
        setRefreshCookie(reply, refreshToken);

        return reply.code(200).send({ message: 'Mot de passe mis à jour', ...result });
      } catch (error) {
        if (error instanceof Error && error.message === 'Current password is incorrect') {
          return reply.code(401).send({ error: 'Mot de passe actuel incorrect' });
        }
        return handleError(reply, error);
      }
    }
  );

  app.patch('/api/v1/auth/me', async (request, reply) => {
    try {
      const token = extractBearerToken(request);
      const claims = await verifyAccessToken(token);
      assertWritableSession(request, claims);
      const body = updateMeSchema.parse(request.body);

      const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
        updateMe(tenantDb, {
          userId: claims.sub,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.profilePhotoUrl !== undefined ? { profilePhotoUrl: body.profilePhotoUrl } : {}),
        })
      );

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });
}
