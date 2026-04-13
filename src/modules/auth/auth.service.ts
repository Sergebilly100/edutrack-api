import argon2 from 'argon2';
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from 'jose';

import {
  findUserByPhone,
  findUserByUsername,
  findUserProfileById,
  updateLastLoginAt,
  type AuthUser,
  type QueryExecutor,
} from './auth.repository.js';

type LoginInput = {
  identifier: string;
  password: string;
  schemaName: string;
};

export type AccessTokenClaims = JWTPayload & {
  sub: string;
  role: AuthUser['role'];
  schemaName: string;
  username?: string;
};

type RefreshTokenClaims = JWTPayload & {
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
    username?: string;
  };
};

export type TenantDb = QueryExecutor;

const normalizePem = (value: string): string => value.replace(/\\n/g, '\n');

const getPrivateKey = async () => {
  const privateKey = process.env.JWT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('[auth] JWT_PRIVATE_KEY environment variable is required');
  }

  return importPKCS8(normalizePem(privateKey), 'RS256');
};

export const getPublicKey = async () => {
  const publicKey = process.env.JWT_PUBLIC_KEY;
  if (!publicKey) {
    throw new Error('[auth] JWT_PUBLIC_KEY environment variable is required');
  }

  return importSPKI(normalizePem(publicKey), 'RS256');
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

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(privateKey);
};

export const signRefreshToken = async (
  userId: string,
  schemaName: string
): Promise<string> => {
  const privateKey = await getPrivateKey();
  const expiry = process.env.JWT_REFRESH_EXPIRY ?? '30d';

  return new SignJWT({ sub: userId, schemaName, type: 'refresh' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(privateKey);
};

export const verifyAccessToken = async (token: string): Promise<AccessTokenClaims> => {
  const publicKey = await getPublicKey();
  const verified = await jwtVerify(token, publicKey, {
    algorithms: ['RS256'],
  });

  const payload = verified.payload as AccessTokenClaims;
  if (!payload.sub || !payload.role || !payload.schemaName) {
    throw new Error('Invalid access token');
  }

  return payload;
};

export const verifyRefreshToken = async (token: string): Promise<RefreshTokenClaims> => {
  const publicKey = await getPublicKey();
  const verified = await jwtVerify(token, publicKey, {
    algorithms: ['RS256'],
  });

  const payload = verified.payload as RefreshTokenClaims;
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
  ...(user.role === 'teacher' && user.username ? { username: user.username } : {}),
});

export const login = async (db: TenantDb, input: LoginInput): Promise<LoginResult> => {
  const authUser = await (async () => {
    const byPhone = await findUserByPhone(db, input.identifier);
    if (byPhone) {
      return byPhone;
    }

    return findUserByUsername(db, input.identifier);
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
