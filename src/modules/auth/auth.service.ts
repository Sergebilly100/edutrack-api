import argon2 from 'argon2';

import {
  invalidateRefreshTokenIfSupported,
  findUserByEmail,
  findUserByPhone,
  findUserByUsername,
  findUserProfileById,
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

export type AccessTokenClaims = JwtPayload & {
  sub: string;
  role: AuthUser['role'];
  schemaName: string;
  username?: string;
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
    role: AuthUser['role'];
    name: string;
    phone: string | null;
    email: string | null;
    profilePhotoUrl: string | null;
    username?: string;
  };
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
  role: user.role,
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
  }) as AccessTokenClaims;
  if (!payload.sub || !payload.role || !payload.schemaName) {
    throw new Error('Invalid access token');
  }

  return payload;
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

const sanitizeProfile = (user: AuthUser) => ({
  id: user.userId,
  role: user.role,
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

  const validPassword = await argon2.verify(authUser.passwordHash, input.password);
  if (!validPassword) {
    throw new Error('Invalid credentials');
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
