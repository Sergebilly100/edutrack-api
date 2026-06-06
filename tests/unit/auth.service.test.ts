import { generateKeyPairSync } from 'node:crypto';

import { importPKCS8, SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  hash: vi.fn(),
  findUserByPhone: vi.fn(),
  findUserByUsername: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserProfileById: vi.fn(),
  updateLastLoginAt: vi.fn(),
  updateUserPasswordHash: vi.fn(),
  revokeAllUserRefreshTokens: vi.fn(),
  listAdministrativePositionNames: vi.fn(),
  recordPasswordReset: vi.fn(),
  getRevokeAt: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: {
    verify: mocks.verify,
    hash: mocks.hash,
  },
}));

vi.mock('../../src/modules/auth/auth.repository.js', () => ({
  findUserByPhone: mocks.findUserByPhone,
  findUserByUsername: mocks.findUserByUsername,
  findUserByEmail: mocks.findUserByEmail,
  findUserProfileById: mocks.findUserProfileById,
  updateLastLoginAt: mocks.updateLastLoginAt,
  updateUserPasswordHash: mocks.updateUserPasswordHash,
  revokeAllUserRefreshTokens: mocks.revokeAllUserRefreshTokens,
  listAdministrativePositionNames: mocks.listAdministrativePositionNames,
}));

vi.mock('../../src/shared/auth/token-version.js', () => ({
  recordPasswordReset: mocks.recordPasswordReset,
  getRevokeAt: mocks.getRevokeAt,
}));

import {
  changePassword,
  getMe,
  getMeFromToken,
  login,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  type TenantDb,
} from '../../src/modules/auth/auth.service.js';

const db: TenantDb = {
  execute: vi.fn(),
};

const activeDirector = {
  userId: 'user-1',
  role: 'director' as const,
  name: 'Directeur Test',
  phone: '2250701234567',
  email: null,
  passwordHash: 'hash',
  isActive: true,
  teacherId: null,
  username: null,
};

const activeTeacher = {
  userId: 'user-2',
  role: 'teacher' as const,
  name: 'Prof Test',
  phone: null,
  email: 'prof@test.ci',
  passwordHash: 'hash2',
  isActive: true,
  teacherId: 'teacher-2',
  username: 'diallo.ibra',
};

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_EXPIRY = '15m';
  process.env.JWT_REFRESH_EXPIRY = '30d';
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUserByEmail.mockResolvedValue(null);
});

describe('auth.service', () => {
  it('login() réussi par phone', async () => {
    mocks.findUserByPhone.mockResolvedValue(activeDirector);
    mocks.findUserByUsername.mockResolvedValue(null);
    mocks.verify.mockResolvedValue(true);

    const result = await login(db, {
      identifier: '2250701234567',
      password: 'test1234',
      schemaName: 'tenant_demo',
    });

    expect(result).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: '15m',
      user: {
        id: 'user-1',
        role: 'director',
      },
    });
    expect(result.accessToken).toBeTypeOf('string');

    const claims = await verifyAccessToken(result.accessToken);
    expect(claims).toMatchObject({
      sub: 'user-1',
      role: 'director',
      schemaName: 'tenant_demo',
    });
    expect(claims.username).toBeUndefined();
  });

  it('login() réussi par username avec username présent', async () => {
    mocks.findUserByPhone.mockResolvedValue(null);
    mocks.findUserByUsername.mockResolvedValue(activeTeacher);
    mocks.verify.mockResolvedValue(true);

    const result = await login(db, {
      identifier: 'diallo.ibra',
      password: 'edutrack2024',
      schemaName: 'tenant_demo',
    });

    expect(result.user.role).toBe('teacher');
    expect(result.user.username).toBe('diallo.ibra');

    const claims = await verifyAccessToken(result.accessToken);
    expect(claims).toMatchObject({
      sub: 'user-2',
      role: 'teacher',
      schemaName: 'tenant_demo',
      username: 'diallo.ibra',
    });
  });

  it('login() échoue si is_active = false', async () => {
    mocks.findUserByPhone.mockResolvedValue({ ...activeDirector, isActive: false });
    mocks.findUserByUsername.mockResolvedValue(null);

    await expect(
      login(db, {
        identifier: '2250701234567',
        password: 'test1234',
        schemaName: 'tenant_demo',
      })
    ).rejects.toThrow('Invalid credentials');
  });

  it('login() échoue si mot de passe incorrect', async () => {
    mocks.findUserByPhone.mockResolvedValue(activeDirector);
    mocks.findUserByUsername.mockResolvedValue(null);
    mocks.verify.mockResolvedValue(false);

    await expect(
      login(db, {
        identifier: '2250701234567',
        password: 'wrong',
        schemaName: 'tenant_demo',
      })
    ).rejects.toThrow('Invalid credentials');
  });

  it('login() échoue si identifier inconnu', async () => {
    mocks.findUserByPhone.mockResolvedValue(null);
    mocks.findUserByUsername.mockResolvedValue(null);
    mocks.findUserByEmail.mockResolvedValue(null);

    await expect(
      login(db, {
        identifier: 'unknown',
        password: 'x',
        schemaName: 'tenant_demo',
      })
    ).rejects.toThrow('Invalid credentials');
  });

  it('getMe() réussi', async () => {
    mocks.findUserProfileById.mockResolvedValue(activeTeacher);

    const result = await getMe(db, 'user-2');

    expect(result).toEqual({
      user: {
        id: 'user-2',
        role: 'teacher',
        name: 'Prof Test',
        phone: null,
        email: 'prof@test.ci',
        username: 'diallo.ibra',
      },
    });
  });

  it('getMe() échoue si profil introuvable', async () => {
    mocks.findUserProfileById.mockResolvedValue(null);

    await expect(getMe(db, 'missing-user')).rejects.toThrow('Invalid credentials');
  });

  it('verifyAccessToken() avec token expiré throw JWTExpired (jose)', async () => {
    const privateKey = await importPKCS8(process.env.JWT_PRIVATE_KEY ?? '', 'RS256');
    const expiredToken = await new SignJWT({
      sub: 'user-2',
      role: 'teacher',
      schemaName: 'tenant_demo',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('1s')
      .sign(privateKey);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    await expect(verifyAccessToken(expiredToken)).rejects.toMatchObject({
      name: 'JWTExpired',
    });
  });

  it('verifyRefreshToken() avec access token (type manquant) throw Invalid refresh token', async () => {
    const privateKey = await importPKCS8(process.env.JWT_PRIVATE_KEY ?? '', 'RS256');
    const invalidRefreshToken = await new SignJWT({
      sub: 'user-2',
      role: 'teacher',
      schemaName: 'tenant_demo',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(privateKey);

    await expect(verifyRefreshToken(invalidRefreshToken)).rejects.toThrow(
      'Invalid refresh token'
    );
  });

  it('signRefreshToken() + verifyRefreshToken() retourne des claims refresh valides', async () => {
    const refreshToken = await signRefreshToken('user-2', 'tenant_demo');

    const claims = await verifyRefreshToken(refreshToken);
    expect(claims).toMatchObject({
      sub: 'user-2',
      schemaName: 'tenant_demo',
      type: 'refresh',
    });
  });

  it('getMeFromToken() retourne le profil utilisateur depuis le JWT', async () => {
    mocks.findUserByPhone.mockResolvedValue(activeTeacher);
    mocks.findUserByUsername.mockResolvedValue(null);
    mocks.verify.mockResolvedValue(true);
    mocks.findUserProfileById.mockResolvedValue(activeTeacher);

    const loginResult = await login(db, {
      identifier: '2250701234567',
      password: 'test1234',
      schemaName: 'tenant_demo',
    });

    const me = await getMeFromToken(db, loginResult.accessToken);
    expect(me).toEqual({
      user: {
        id: 'user-2',
        role: 'teacher',
        name: 'Prof Test',
        phone: null,
        email: 'prof@test.ci',
        username: 'diallo.ibra',
      },
    });
  });
});

describe('changePassword()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateUserPasswordHash.mockResolvedValue(undefined);
    mocks.revokeAllUserRefreshTokens.mockResolvedValue(undefined);
    mocks.listAdministrativePositionNames.mockResolvedValue([]);
    mocks.recordPasswordReset.mockResolvedValue(undefined);
    // revokeAt dans le passé → signAccessTokenAfter passe immédiatement
    mocks.getRevokeAt.mockResolvedValue(0);
  });

  it('rejette si le mot de passe actuel est incorrect', async () => {
    mocks.findUserProfileById.mockResolvedValue(activeDirector);
    mocks.verify.mockResolvedValue(false);

    await expect(
      changePassword(db, {
        userId: 'user-1',
        currentPassword: 'mauvais',
        newPassword: 'NouveauMdp1!',
        schemaName: 'school_test',
      })
    ).rejects.toThrow('Current password is incorrect');

    expect(mocks.updateUserPasswordHash).not.toHaveBeenCalled();
    expect(mocks.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
  });

  it("rejette si l'utilisateur n'existe pas", async () => {
    mocks.findUserProfileById.mockResolvedValue(null);

    await expect(
      changePassword(db, {
        userId: 'inexistant',
        currentPassword: 'Test1234!',
        newPassword: 'Nouveau1!',
        schemaName: 'school_test',
      })
    ).rejects.toThrow('Invalid credentials');
  });

  it('retourne un nouveau accessToken valide après le changement', async () => {
    mocks.findUserProfileById.mockResolvedValue(activeDirector);
    mocks.verify.mockResolvedValue(true);
    mocks.hash.mockResolvedValue('new-hash');

    const result = await changePassword(db, {
      userId: 'user-1',
      currentPassword: 'AncienMdp1!',
      newPassword: 'NouveauMdp1!',
      schemaName: 'school_test',
    });

    expect(result.accessToken).toBeTruthy();
    expect(result.user.id).toBe('user-1');
    expect(mocks.updateUserPasswordHash).toHaveBeenCalledWith(db, 'user-1', 'new-hash');
    expect(mocks.revokeAllUserRefreshTokens).toHaveBeenCalledWith(db, 'user-1');
    expect(mocks.recordPasswordReset).toHaveBeenCalledWith('school_test', 'user-1');

    // Le token émis doit être vérifiable
    const claims = await verifyAccessToken(result.accessToken);
    expect(claims.sub).toBe('user-1');
    expect(claims.role).toBe('director');
  });

  it('le token émis a un iat strictement supérieur à revokeAt', async () => {
    const revokeAt = Math.floor(Date.now() / 1000) - 2;
    mocks.getRevokeAt.mockResolvedValue(revokeAt);
    mocks.findUserProfileById.mockResolvedValue(activeDirector);
    mocks.verify.mockResolvedValue(true);
    mocks.hash.mockResolvedValue('new-hash');

    const result = await changePassword(db, {
      userId: 'user-1',
      currentPassword: 'AncienMdp1!',
      newPassword: 'NouveauMdp1!',
      schemaName: 'school_test',
    });

    const claims = await verifyAccessToken(result.accessToken);
    expect(claims.iat).toBeGreaterThan(revokeAt);
  });
});
