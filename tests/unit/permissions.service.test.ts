import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hash: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: {
    hash: mocks.hash,
  },
}));

import {
  PermissionsModuleError,
  PermissionsService,
} from '../../src/modules/permissions/permissions.service.js';

const repository = {
  getSchoolConfigBySchemaName: vi.fn(),
  countActiveAdministrativeUsers: vi.fn(),
  createAdministrativeUser: vi.fn(),
  reactivateInactiveAdministrativeUserByContact: vi.fn(),
};

describe('permissions.service createAdministrativeUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hash.mockResolvedValue('hashed-password');
  });

  it('bloque la création quand la limite admin est atteinte', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({
      max_admin_positions: 2,
    });
    repository.countActiveAdministrativeUsers.mockResolvedValue(2);

    const service = new PermissionsService(repository as never);

    await expect(
      service.createAdministrativeUser(
        {
          name: 'Staff Test',
          email: 'staff@test.ci',
          phone: '2250700000001',
          password: 'Password123',
        },
        { schemaName: 'school_sainte_marie' }
      )
    ).rejects.toMatchObject<Partial<PermissionsModuleError>>({
      code: 'ADMIN_USERS_LIMIT_REACHED',
      statusCode: 403,
    });
  });

  it('réactive un ancien staff inactif en cas de conflit unique', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({
      max_admin_positions: 5,
    });
    repository.countActiveAdministrativeUsers.mockResolvedValue(1);
    repository.createAdministrativeUser.mockRejectedValue({
      code: '23505',
      constraint: 'users_email_unique',
    });
    repository.reactivateInactiveAdministrativeUserByContact.mockResolvedValue({
      id: 'staff-1',
      name: 'Staff Réactivé',
      role: 'staff',
      email: 'staff@test.ci',
      phone: '2250700000001',
    });

    const service = new PermissionsService(repository as never);
    const result = await service.createAdministrativeUser(
      {
        name: 'Staff Réactivé',
        email: 'staff@test.ci',
        phone: '2250700000001',
        password: 'Password123',
      },
      { schemaName: 'school_sainte_marie' }
    );

    expect(result.user).toMatchObject({
      id: 'staff-1',
      name: 'Staff Réactivé',
      role: 'staff',
    });
    expect(repository.reactivateInactiveAdministrativeUserByContact).toHaveBeenCalledOnce();
  });

  it('retourne EMAIL_ALREADY_USED si conflit actif non réactivable', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({
      max_admin_positions: 5,
    });
    repository.countActiveAdministrativeUsers.mockResolvedValue(1);
    repository.createAdministrativeUser.mockRejectedValue({
      code: '23505',
      detail: 'Key (email)=(used@test.ci) already exists.',
    });
    repository.reactivateInactiveAdministrativeUserByContact.mockResolvedValue(null);

    const service = new PermissionsService(repository as never);

    await expect(
      service.createAdministrativeUser(
        {
          name: 'Staff',
          email: 'used@test.ci',
          phone: '2250700000001',
          password: 'Password123',
        },
        { schemaName: 'school_sainte_marie' }
      )
    ).rejects.toMatchObject<Partial<PermissionsModuleError>>({
      code: 'EMAIL_ALREADY_USED',
      statusCode: 409,
    });
  });
});
