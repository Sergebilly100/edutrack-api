import { generateKeyPairSync } from 'node:crypto';

import { importPKCS8, SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  findUserByPhone: vi.fn(),
  findUserByUsername: vi.fn(),
  findUserProfileById: vi.fn(),
  updateLastLoginAt: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: {
    verify: mocks.verify,
  },
}));

vi.mock('../../src/modules/auth/auth.repository.js', () => ({
  findUserByPhone: mocks.findUserByPhone,
  findUserByUsername: mocks.findUserByUsername,
  findUserProfileById: mocks.findUserProfileById,
  updateLastLoginAt: mocks.updateLastLoginAt,
}));

import {
  getMe,
  getMeFromToken,
  login,
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

  it('getMe() avec token expiré throw (jose)', async () => {
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

    await expect(getMeFromToken(db, expiredToken)).rejects.toThrow();
  });
});
