import argon2 from 'argon2';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import {
  bindKeycloakSubjectIfNeeded,
  getRefreshTokenStatus,
  invalidateRefreshTokenIfSupported,
  listActiveRefreshSessions,
  findUserByEmail,
  findUserByPhone,
  findUserByUsername,
  findUserProfileById,
  listAdministrativePositionNames,
  revokeRefreshSessionById,
  storeRefreshToken,
  updateUserProfile,
  updateUserPasswordHash,
  updateLastLoginAt,
  type AuthUser,
  type QueryExecutor,
} from './auth.repository.js';
import {
  signJwtRs256,
  verifyJwtRs256,
  type JwtPayload,
} from '../../shared/auth/jwt.js';

type LoginInput = {
  identifier: string;
  password: string;
  schemaName: string;
};

export type UserRole = 'director' | 'staff' | 'teacher' | 'super_admin' | 'parent';
type LegacyUserRole = UserRole | 'secretary';

export type AccessTokenClaims = JwtPayload & {
  sub: string;
  role: UserRole;
  schemaName: string;
  username?: string;
  studentIds?: string[];
  mustChangePassword?: boolean;
  readOnly?: boolean;
  impersonation?: boolean;
  impersonatedBy?: string;
  tenantId?: string;
  phone?: string;
  fullName?: string;
  email?: string | null;
};

type RefreshTokenClaims = JwtPayload & {
  sub: string;
  schemaName: string;
  type: 'refresh';
  jti?: string;
};

export type LoginResult = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
  user: {
    id: string;
    role: UserRole;
    name: string;
    phone: string | null;
    email: string | null;
    profilePhotoUrl: string | null;
    positionNames?: string[];
    primaryPosition?: string | null;
    username?: string;
  };
};

const normalizeRole = (role: LegacyUserRole): UserRole => {
  if (role === 'secretary') {
    return 'staff';
  }
  return role;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getRows = <TRow,>(result: unknown): TRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as { rows: TRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
};

const isLegacyRefreshFallbackEnabled = (): boolean =>
  parseBooleanEnv(process.env.AUTH_ALLOW_LEGACY_REFRESH, false);

const decodeJwtPayload = (token: string): Record<string, unknown> => {
  const parts = token.split('.');
  const payloadBase64 = parts[1];
  if (!payloadBase64) {
    return {};
  }

  const normalized = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const raw = Buffer.from(padded, 'base64').toString('utf8');
  const parsed = JSON.parse(raw) as unknown;
  return isObject(parsed) ? parsed : {};
};

const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export type TenantDb = QueryExecutor;

type ChangePasswordInput = {
  userId: string;
  currentPassword: string;
  newPassword: string;
};

type UpdateMeInput = {
  userId: string;
  name?: string;
  phone?: string | null;
  profilePhotoUrl?: string | null;
};

const normalizePem = (value: string): string => {
  const trimmed = value.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;

  return unquoted.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
};

const isKeycloakAuthEnabled = (): boolean =>
  (process.env.AUTH_PROVIDER ?? 'local').trim().toLowerCase() === 'keycloak';

const getKeycloakRequestTimeoutMs = (): number => {
  const parsed = Number.parseInt(process.env.KEYCLOAK_REQUEST_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5000;
  }
  return parsed;
};

const shouldFallbackToLocalOnKeycloakUnavailable = (): boolean =>
  parseBooleanEnv(process.env.AUTH_KEYCLOAK_FALLBACK_LOCAL, true);

const getKeycloakConfig = (): {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret?: string;
} => {
  const baseUrl = process.env.KEYCLOAK_BASE_URL?.trim();
  const realm = process.env.KEYCLOAK_REALM?.trim();
  const clientId = process.env.KEYCLOAK_CLIENT_ID?.trim();
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET?.trim();

  if (!baseUrl || !realm || !clientId) {
    throw new Error(
      'Keycloak auth enabled but KEYCLOAK_BASE_URL, KEYCLOAK_REALM or KEYCLOAK_CLIENT_ID is missing'
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    realm,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
  };
};

const getKeycloakTenantClaimConfig = (): {
  claimName: string;
  requireMatch: boolean;
} => {
  const claimName = (process.env.KEYCLOAK_TENANT_CLAIM ?? 'schemaName').trim() || 'schemaName';
  const requireMatch = parseBooleanEnv(process.env.KEYCLOAK_REQUIRE_TENANT_CLAIM, false);
  return { claimName, requireMatch };
};

type KeycloakVerificationResult = {
  subject: string;
  claims: Record<string, unknown>;
};

class KeycloakUnavailableError extends Error {
  constructor(message = 'Keycloak unavailable') {
    super(message);
    this.name = 'KeycloakUnavailableError';
  }
}

const verifyCredentialsWithKeycloak = async (
  identifier: string,
  password: string
): Promise<KeycloakVerificationResult> => {
  const config = getKeycloakConfig();
  const tokenEndpoint = `${config.baseUrl}/realms/${encodeURIComponent(
    config.realm
  )}/protocol/openid-connect/token`;

  const form = new URLSearchParams();
  form.set('grant_type', 'password');
  form.set('client_id', config.clientId);
  if (config.clientSecret) {
    form.set('client_secret', config.clientSecret);
  }
  form.set('username', identifier);
  form.set('password', password);

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(getKeycloakRequestTimeoutMs()),
    });
  } catch (error) {
    throw new KeycloakUnavailableError(
      error instanceof Error ? error.message : 'Unable to reach Keycloak'
    );
  }

  if (!response.ok) {
    throw new Error('Invalid credentials');
  }

  const payload = (await response.json()) as unknown;
  if (!isObject(payload)) {
    throw new Error('Invalid credentials');
  }

  const accessToken =
    typeof payload.access_token === 'string' ? payload.access_token : '';
  const idToken = typeof payload.id_token === 'string' ? payload.id_token : '';
  const claims = idToken ? decodeJwtPayload(idToken) : decodeJwtPayload(accessToken);
  const subject = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!subject) {
    throw new Error('Invalid credentials');
  }

  return { subject, claims };
};

const getPrivateKey = async () => {
  const privateKey = process.env.JWT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('[auth] JWT_PRIVATE_KEY environment variable is required');
  }

  return normalizePem(privateKey);
};

export const getPublicKey = async () => {
  const publicKey = process.env.JWT_PUBLIC_KEY;
  if (!publicKey) {
    throw new Error('[auth] JWT_PUBLIC_KEY environment variable is required');
  }

  return normalizePem(publicKey);
};

export const buildClaims = (user: AuthUser, schemaName: string): AccessTokenClaims => ({
  sub: user.userId,
  role: normalizeRole(user.role),
  schemaName,
  ...(user.role === 'teacher' && user.username ? { username: user.username } : {}),
});

export const signAccessToken = async (claims: AccessTokenClaims): Promise<string> => {
  const privateKey = await getPrivateKey();
  const expiry = process.env.JWT_EXPIRY ?? '15m';

  return signJwtRs256({
    payload: claims,
    privateKeyPem: privateKey,
    expiresIn: expiry,
  });
};

export const signRefreshToken = async (
  userId: string,
  schemaName: string
): Promise<string> => {
  const privateKey = await getPrivateKey();
  const expiry = process.env.JWT_REFRESH_EXPIRY ?? '30d';

  return signJwtRs256({
    payload: { sub: userId, schemaName, type: 'refresh', jti: randomUUID() },
    privateKeyPem: privateKey,
    expiresIn: expiry,
  });
};

export const verifyAccessToken = async (token: string): Promise<AccessTokenClaims> => {
  const publicKey = await getPublicKey();
  const payload = verifyJwtRs256({
    token,
    publicKeyPem: publicKey,
  }) as unknown;

  if (!isObject(payload)) {
    throw new Error('Invalid access token');
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const role = payload.role;
  const schemaName = typeof payload.schemaName === 'string' ? payload.schemaName : '';
  const username = typeof payload.username === 'string' ? payload.username : undefined;
  const studentIds = Array.isArray(payload.studentIds)
    ? payload.studentIds.filter((value): value is string => typeof value === 'string')
    : undefined;
  const readOnly = payload.readOnly === true;
  const impersonation = payload.impersonation === true;
  const impersonatedBy =
    typeof payload.impersonatedBy === 'string' ? payload.impersonatedBy : undefined;
  const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : undefined;

  if (!sub || !schemaName) {
    throw new Error('Invalid access token');
  }

  if (
    role !== 'director' &&
    role !== 'staff' &&
    role !== 'teacher' &&
    role !== 'super_admin' &&
    role !== 'parent' &&
    role !== 'secretary'
  ) {
    throw new Error('Invalid access token');
  }

  return {
    ...payload,
    sub,
    role: normalizeRole(role),
    schemaName,
    ...(username ? { username } : {}),
    ...(studentIds ? { studentIds } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(impersonation ? { impersonation: true } : {}),
    ...(impersonatedBy ? { impersonatedBy } : {}),
    ...(tenantId ? { tenantId } : {}),
  } as AccessTokenClaims;
};

export const verifyRefreshToken = async (token: string): Promise<RefreshTokenClaims> => {
  const publicKey = await getPublicKey();
  const payload = verifyJwtRs256({
    token,
    publicKeyPem: publicKey,
  }) as RefreshTokenClaims;
  if (
    payload.type !== 'refresh' ||
    !payload.sub ||
    typeof payload.schemaName !== 'string'
  ) {
    throw new Error('Invalid refresh token');
  }

  return payload;
};

const getRefreshTokenExpiryIso = (token: string): string | null => {
  try {
    const payload = decodeJwtPayload(token);
    const exp = payload.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) {
      return null;
    }
    return new Date(exp * 1000).toISOString();
  } catch {
    return null;
  }
};

const sanitizeProfile = (user: AuthUser, positionNames: string[] = []) => {
  const normalizedRole = normalizeRole(user.role);

  return {
    id: user.userId,
    role: normalizedRole,
    name: user.name,
    phone: user.phone,
    email: user.email,
    profilePhotoUrl: user.profilePhotoUrl,
    ...(normalizedRole === 'staff'
      ? {
          positionNames,
          primaryPosition: positionNames[0] ?? null,
        }
      : {}),
    ...(user.role === 'teacher' && user.username ? { username: user.username } : {}),
  };
};

export const login = async (db: TenantDb, input: LoginInput): Promise<LoginResult> => {
  const authUser = await (async () => {
    const byPhone = await findUserByPhone(db, input.identifier);
    if (byPhone) {
      return byPhone;
    }

    const byUsername = await findUserByUsername(db, input.identifier);
    if (byUsername) {
      return byUsername;
    }

    return findUserByEmail(db, input.identifier);
  })();

  if (!authUser || !authUser.isActive) {
    throw new Error('Invalid credentials');
  }

  if (isKeycloakAuthEnabled()) {
    try {
      const keycloakVerification = await verifyCredentialsWithKeycloak(
        input.identifier,
        input.password
      );
      const { claimName, requireMatch } = getKeycloakTenantClaimConfig();
      const tenantClaim =
        typeof keycloakVerification.claims[claimName] === 'string'
          ? String(keycloakVerification.claims[claimName]).trim()
          : '';
      if (requireMatch && tenantClaim !== input.schemaName) {
        throw new Error('Invalid credentials');
      }
      if (
        authUser.keycloakSubject &&
        authUser.keycloakSubject !== keycloakVerification.subject
      ) {
        throw new Error('Invalid credentials');
      }
      await bindKeycloakSubjectIfNeeded(db, authUser.userId, keycloakVerification.subject);
    } catch (error) {
      if (
        error instanceof KeycloakUnavailableError &&
        shouldFallbackToLocalOnKeycloakUnavailable()
      ) {
        const validPassword = await argon2.verify(authUser.passwordHash, input.password);
        if (!validPassword) {
          throw new Error('Invalid credentials');
        }
      } else {
        throw error;
      }
    }
  } else {
    const validPassword = await argon2.verify(authUser.passwordHash, input.password);
    if (!validPassword) {
      throw new Error('Invalid credentials');
    }
  }

  const claims = buildClaims(authUser, input.schemaName);
  const accessToken = await signAccessToken(claims);
  const positionNames =
    normalizeRole(authUser.role) === 'staff'
      ? await listAdministrativePositionNames(db, authUser.userId)
      : [];

  void updateLastLoginAt(db, authUser.userId);

  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: process.env.JWT_EXPIRY ?? '15m',
    user: sanitizeProfile(authUser, positionNames),
  };
};

export const getMe = async (db: TenantDb, userId: string) => {
  const profile = await findUserProfileById(db, userId);

  if (!profile || !profile.isActive) {
    throw new Error('Invalid credentials');
  }

  const positionNames =
    normalizeRole(profile.role) === 'staff'
      ? await listAdministrativePositionNames(db, profile.userId)
      : [];

  return {
    user: sanitizeProfile(profile, positionNames),
  };
};

export const getMeFromToken = async (db: TenantDb, token: string) => {
  const claims = await verifyAccessToken(token);
  return getMe(db, claims.sub);
};

export const refreshAccessToken = async (
  db: TenantDb,
  refreshToken: string,
  context?: { userAgent?: string | null; ipAddress?: string | null } | null
) => {
  const payload = await verifyRefreshToken(refreshToken);
  const profile = await findUserProfileById(db, payload.sub);
  if (profile && profile.isActive) {
    const status = await getRefreshTokenStatus(db, refreshToken);
    const shouldInvalidatePreviousToken = status !== 'inactive';
    if (status !== 'active') {
      if (status === 'inactive') {
        throw new Error('Invalid refresh token');
      }

      if (!isLegacyRefreshFallbackEnabled()) {
        throw new Error('Invalid refresh token');
      }

      await storeRefreshToken(db, {
        userId: payload.sub,
        token: refreshToken,
        expiresAt: getRefreshTokenExpiryIso(refreshToken),
      });
    }

    const claims = buildClaims(profile, payload.schemaName);
    const accessToken = await signAccessToken(claims);
    const nextRefreshToken = await signRefreshToken(payload.sub, payload.schemaName);
    await registerRefreshToken(db, nextRefreshToken, context ?? null);
    if (shouldInvalidatePreviousToken) {
      await invalidateRefreshTokenIfSupported(db, {
        refreshToken,
        userId: payload.sub,
      });
    }

    return {
      accessToken,
      refreshToken: nextRefreshToken,
      tokenType: 'Bearer' as const,
      expiresIn: process.env.JWT_EXPIRY ?? '15m',
    };
  }

  let parentResult: unknown;
  try {
    parentResult = await db.execute(sql`
      SELECT
        id::text AS id,
        phone,
        full_name,
        email,
        is_active,
        must_change_password
      FROM parents
      WHERE id = ${payload.sub}::uuid
      LIMIT 1
    `);
  } catch {
    parentResult = await db.execute(sql`
      SELECT
        id::text AS id,
        phone,
        full_name,
        email,
        is_active,
        false AS must_change_password
      FROM parents
      WHERE id = ${payload.sub}::uuid
      LIMIT 1
    `);
  }
  const parent = getRows<{
    id: string;
    phone: string;
    full_name: string;
    email: string | null;
    is_active: boolean;
    must_change_password: boolean;
  }>(parentResult)[0];
  if (!parent || !parent.is_active) {
    throw new Error('Invalid credentials');
  }

  const studentRows = await db.execute(sql`
    SELECT DISTINCT psl.student_id::text AS student_id
    FROM parent_student_links psl
    INNER JOIN parent_subscriptions ps ON ps.id = psl.subscription_id
    WHERE psl.parent_id = ${parent.id}::uuid
      AND ps.status = 'active'
      AND ps.ends_at >= CURRENT_DATE
  `);
  const studentIds = getRows<{ student_id: string }>(studentRows).map((row) => row.student_id);
  if (studentIds.length === 0) {
    throw new Error('Invalid credentials');
  }

  const parentClaims: AccessTokenClaims = {
    sub: parent.id,
    role: 'parent',
    schemaName: payload.schemaName,
    phone: parent.phone,
    fullName: parent.full_name,
    email: parent.email,
    studentIds,
    mustChangePassword: parent.must_change_password,
  };
  const parentAccessToken = await signAccessToken(parentClaims);
  const parentNextRefreshToken = await signRefreshToken(payload.sub, payload.schemaName);
  return {
    accessToken: parentAccessToken,
    refreshToken: parentNextRefreshToken,
    tokenType: 'Bearer' as const,
    expiresIn: process.env.JWT_EXPIRY ?? '15m',
  };
};

export const registerRefreshToken = async (
  db: TenantDb,
  refreshToken: string,
  context?: { userAgent?: string | null; ipAddress?: string | null } | null
): Promise<void> => {
  const payload = await verifyRefreshToken(refreshToken);
  await storeRefreshToken(db, {
    userId: payload.sub,
    token: refreshToken,
    expiresAt: getRefreshTokenExpiryIso(refreshToken),
    userAgent: context?.userAgent ?? null,
    ipAddress: context?.ipAddress ?? null,
  });
};

export type ActiveSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  isCurrent: boolean;
};

export const listUserSessions = async (
  db: TenantDb,
  input: { userId: string; currentRefreshToken?: string }
): Promise<ActiveSession[]> => {
  const sessions = await listActiveRefreshSessions(db, input.userId);
  const currentRefreshHash = input.currentRefreshToken
    ? hashRefreshToken(input.currentRefreshToken)
    : null;
  return sessions.map((session) => ({
    id: session.id,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    lastUsedAt: session.last_used_at,
    expiresAt: session.expires_at,
    userAgent: session.user_agent,
    ipAddress: session.ip_address,
    isCurrent: currentRefreshHash !== null && currentRefreshHash === session.token_hash,
  }));
};

export const revokeUserSession = async (
  db: TenantDb,
  input: { userId: string; sessionId: string }
): Promise<boolean> => {
  return revokeRefreshSessionById(db, {
    userId: input.userId,
    sessionId: input.sessionId,
  });
};

export const logout = async (db: TenantDb, refreshToken?: string): Promise<void> => {
  if (!refreshToken) {
    return;
  }

  try {
    const payload = await verifyRefreshToken(refreshToken);
    await invalidateRefreshTokenIfSupported(db, {
      refreshToken,
      userId: payload.sub,
    });
  } catch {
    // No-op by design: logout must stay idempotent and never fail on invalid refresh tokens.
  }
};

export const changePassword = async (
  db: TenantDb,
  input: ChangePasswordInput
): Promise<void> => {
  if (isKeycloakAuthEnabled()) {
    throw new Error('Modification de mot de passe non autorisée pour ce rôle');
  }

  const profile = await findUserProfileById(db, input.userId);
  if (!profile || !profile.isActive) {
    throw new Error('Invalid credentials');
  }

  const isCurrentPasswordValid = await argon2.verify(profile.passwordHash, input.currentPassword);
  if (!isCurrentPasswordValid) {
    throw new Error('Current password is incorrect');
  }

  const passwordHash = await argon2.hash(input.newPassword);
  await updateUserPasswordHash(db, profile.userId, passwordHash);
};

export const updateMe = async (db: TenantDb, input: UpdateMeInput) => {
  await updateUserProfile(db, input.userId, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.profilePhotoUrl !== undefined ? { profilePhotoUrl: input.profilePhotoUrl } : {}),
  });

  const profile = await findUserProfileById(db, input.userId);
  if (!profile || !profile.isActive) {
    throw new Error('Invalid credentials');
  }

  const positionNames =
    normalizeRole(profile.role) === 'staff'
      ? await listAdministrativePositionNames(db, profile.userId)
      : [];

  return {
    user: sanitizeProfile(profile, positionNames),
  };
};
