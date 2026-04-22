import argon2 from 'argon2';

import {
  bindKeycloakSubjectIfNeeded,
  invalidateRefreshTokenIfSupported,
  isRefreshTokenActive,
  findUserByEmail,
  findUserByPhone,
  findUserByUsername,
  findUserProfileById,
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

export type UserRole = 'director' | 'staff' | 'teacher' | 'super_admin';
type LegacyUserRole = UserRole | 'secretary';

export type AccessTokenClaims = JwtPayload & {
  sub: string;
  role: UserRole;
  schemaName: string;
  username?: string;
  readOnly?: boolean;
  impersonation?: boolean;
  impersonatedBy?: string;
  tenantId?: string;
};

type RefreshTokenClaims = JwtPayload & {
  sub: string;
  schemaName: string;
  type: 'refresh';
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
  email?: string | null;
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

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });

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
    payload: { sub: userId, schemaName, type: 'refresh' },
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

const sanitizeProfile = (user: AuthUser) => ({
  id: user.userId,
  role: normalizeRole(user.role),
  name: user.name,
  phone: user.phone,
  email: user.email,
  profilePhotoUrl: user.profilePhotoUrl,
  ...(user.role === 'teacher' && user.username ? { username: user.username } : {}),
});

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
  } else {
    const validPassword = await argon2.verify(authUser.passwordHash, input.password);
    if (!validPassword) {
      throw new Error('Invalid credentials');
    }
  }

  const claims = buildClaims(authUser, input.schemaName);
  const accessToken = await signAccessToken(claims);

  void updateLastLoginAt(db, authUser.userId);

  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: process.env.JWT_EXPIRY ?? '15m',
    user: sanitizeProfile(authUser),
  };
};

export const getMe = async (db: TenantDb, userId: string) => {
  const profile = await findUserProfileById(db, userId);

  if (!profile || !profile.isActive) {
    throw new Error('Invalid credentials');
  }

  return {
    user: sanitizeProfile(profile),
  };
};

export const getMeFromToken = async (db: TenantDb, token: string) => {
  const claims = await verifyAccessToken(token);
  return getMe(db, claims.sub);
};

export const refreshAccessToken = async (db: TenantDb, refreshToken: string) => {
  const payload = await verifyRefreshToken(refreshToken);
  const isActive = await isRefreshTokenActive(db, refreshToken);
  if (!isActive) {
    throw new Error('Invalid refresh token');
  }

  const profile = await findUserProfileById(db, payload.sub);
  if (!profile || !profile.isActive) {
    throw new Error('Invalid credentials');
  }

  const claims = buildClaims(profile, payload.schemaName);
  const accessToken = await signAccessToken(claims);

  return {
    accessToken,
    tokenType: 'Bearer' as const,
    expiresIn: process.env.JWT_EXPIRY ?? '15m',
  };
};

export const registerRefreshToken = async (db: TenantDb, refreshToken: string): Promise<void> => {
  const payload = await verifyRefreshToken(refreshToken);
  await storeRefreshToken(db, {
    userId: payload.sub,
    token: refreshToken,
    expiresAt: getRefreshTokenExpiryIso(refreshToken),
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
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.profilePhotoUrl !== undefined ? { profilePhotoUrl: input.profilePhotoUrl } : {}),
  });

  const profile = await findUserProfileById(db, input.userId);
  if (!profile || !profile.isActive) {
    throw new Error('Invalid credentials');
  }

  return {
    user: sanitizeProfile(profile),
  };
};
