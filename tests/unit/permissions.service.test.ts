import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hash: vi.fn(),
  getPlanLimitsBySchemaName: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: { hash: mocks.hash },
}));

vi.mock('../../src/shared/utils/users-limit.js', () => ({
  getPlanLimitsBySchemaName: mocks.getPlanLimitsBySchemaName,
  buildUsersLimitReachedMessage: (current: number, max: number) => `Limite ${current}/${max}`,
  getMaxUsersBySchemaName: vi.fn(),
}));

import {
  PermissionsModuleError,
  PermissionsService,
  resolveEffectivePermissions,
} from '../../src/modules/permissions/permissions.service.js';

const repository = {
  getSchoolConfigBySchemaName: vi.fn(),
  countActiveUsers: vi.fn(),
  countActiveAdministrativeUsers: vi.fn(),
  createAdministrativeUser: vi.fn(),
  reactivateInactiveAdministrativeUserByContact: vi.fn(),
  findPositionById: vi.fn(),
  deletePosition: vi.fn(),
  canReceivePositionAssignment: vi.fn(),
  assignPosition: vi.fn(),
  countAssignments: vi.fn(),
  listAssignedPermissions: vi.fn(),
  createPosition: vi.fn(),
  updateAdministrativeUserPasswordHash: vi.fn(),
  revokeAllUserRefreshTokens: vi.fn(),
  findAdministrativeUserById: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hash.mockResolvedValue('hashed-password');
  mocks.getPlanLimitsBySchemaName.mockResolvedValue({ max_users: 100, max_admin_positions: 10 });
  repository.countActiveUsers.mockResolvedValue(0);
  repository.countActiveAdministrativeUsers.mockResolvedValue(0);
  repository.getSchoolConfigBySchemaName.mockResolvedValue({
    can_edit_sms_template: false,
    monetize_parent_alerts: false,
    max_admin_positions: 10,
  });
  repository.revokeAllUserRefreshTokens.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Suite 1 : createAdministrativeUser
// ---------------------------------------------------------------------------
describe('permissions.service createAdministrativeUser', () => {
  it('bloque la création quand la limite admin est atteinte', async () => {
    // La limite admin vient de planLimits.max_admin_positions
    mocks.getPlanLimitsBySchemaName.mockResolvedValue({ max_users: 100, max_admin_positions: 2 });
    repository.countActiveUsers.mockResolvedValue(1);
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
    repository.createAdministrativeUser.mockRejectedValue({
      code: '23505',
      constraint: 'users_email_unique',
      detail: '',
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
    repository.createAdministrativeUser.mockRejectedValue({
      code: '23505',
      constraint: 'users_email_unique',
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

  it('bloque la création quand la limite max_users du plan est atteinte', async () => {
    mocks.getPlanLimitsBySchemaName.mockResolvedValue({ max_users: 5, max_admin_positions: 10 });
    repository.countActiveUsers.mockResolvedValue(5);
    repository.countActiveAdministrativeUsers.mockResolvedValue(0);

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
      code: 'PLAN_LIMIT_REACHED',
      statusCode: 403,
    });
  });

  it('retourne PHONE_ALREADY_USED si conflit téléphone sur user actif non réactivable', async () => {
    repository.createAdministrativeUser.mockRejectedValue({
      code: '23505',
      constraint: 'users_phone_unique',
      detail: '',
    });
    repository.reactivateInactiveAdministrativeUserByContact.mockResolvedValue(null);

    const service = new PermissionsService(repository as never);

    await expect(
      service.createAdministrativeUser(
        {
          name: 'Staff',
          email: 'staff@test.ci',
          phone: '2250700000001',
          password: 'Password123',
        },
        { schemaName: 'school_sainte_marie' }
      )
    ).rejects.toMatchObject<Partial<PermissionsModuleError>>({
      code: 'PHONE_ALREADY_USED',
      statusCode: 409,
    });
  });

  it('retourne DUPLICATE_USER si contrainte 23505 non identifiée', async () => {
    repository.createAdministrativeUser.mockRejectedValue({
      code: '23505',
      constraint: 'some_other_unique',
      detail: '',
    });
    repository.reactivateInactiveAdministrativeUserByContact.mockResolvedValue(null);

    const service = new PermissionsService(repository as never);

    await expect(
      service.createAdministrativeUser(
        {
          name: 'Staff',
          email: 'staff@test.ci',
          phone: '2250700000001',
          password: 'Password123',
        },
        { schemaName: 'school_sainte_marie' }
      )
    ).rejects.toMatchObject<Partial<PermissionsModuleError>>({
      code: 'DUPLICATE_USER',
      statusCode: 409,
    });
  });

  it("hache le mot de passe avant de créer l'utilisateur", async () => {
    mocks.hash.mockResolvedValue('argon2-hash-xyz');
    repository.createAdministrativeUser.mockResolvedValue({
      id: 'user-1',
      name: 'Staff Hash',
      role: 'staff',
      email: 'hash@test.ci',
      phone: null,
    });

    const service = new PermissionsService(repository as never);
    await service.createAdministrativeUser(
      {
        name: 'Staff Hash',
        email: 'hash@test.ci',
        password: 'Password123',
      },
      { schemaName: 'school_sainte_marie' }
    );

    expect(repository.createAdministrativeUser).toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: 'argon2-hash-xyz' })
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 2 : deletePosition
// ---------------------------------------------------------------------------
describe('permissions.service deletePosition', () => {
  it('supprime un poste sans assignation', async () => {
    repository.findPositionById.mockResolvedValue({ id: 'pos-1', assignmentsCount: 0 });
    repository.deletePosition.mockResolvedValue(true);

    const service = new PermissionsService(repository as never);
    const result = await service.deletePosition('pos-1');

    expect(result).toEqual({ deleted: true });
  });

  it('bloque la suppression si le poste a des assignations', async () => {
    repository.findPositionById.mockResolvedValue({ id: 'pos-1', assignmentsCount: 2 });

    const service = new PermissionsService(repository as never);

    await expect(service.deletePosition('pos-1')).rejects.toMatchObject<
      Partial<PermissionsModuleError>
    >({
      code: 'POSITION_HAS_ASSIGNMENTS',
      statusCode: 409,
    });
  });

  it("bloque la suppression si le poste n'existe pas", async () => {
    repository.findPositionById.mockResolvedValue(null);

    const service = new PermissionsService(repository as never);

    await expect(service.deletePosition('pos-999')).rejects.toMatchObject<
      Partial<PermissionsModuleError>
    >({
      code: 'POSITION_NOT_FOUND',
      statusCode: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 3 : assignPosition
// ---------------------------------------------------------------------------
describe('permissions.service assignPosition', () => {
  it('assigne un staff à un poste', async () => {
    repository.findPositionById.mockResolvedValue({ id: 'pos-1', assignmentsCount: 0 });
    repository.canReceivePositionAssignment.mockResolvedValue(true);
    repository.assignPosition.mockResolvedValue(undefined);
    repository.countAssignments.mockResolvedValue(1);

    const service = new PermissionsService(repository as never);
    const result = await service.assignPosition({
      positionId: 'pos-1',
      userId: 'user-1',
      assignedBy: 'director-1',
    });

    expect(result).toEqual({ assigned: true, assignmentsCount: 1 });
  });

  it("bloque l'assignation si l'utilisateur n'est pas staff", async () => {
    repository.findPositionById.mockResolvedValue({ id: 'pos-1', assignmentsCount: 0 });
    repository.canReceivePositionAssignment.mockResolvedValue(false);

    const service = new PermissionsService(repository as never);

    await expect(
      service.assignPosition({
        positionId: 'pos-1',
        userId: 'user-1',
        assignedBy: 'director-1',
      })
    ).rejects.toMatchObject<Partial<PermissionsModuleError>>({
      code: 'INVALID_ASSIGNMENT_TARGET',
      statusCode: 400,
    });
  });

  it("bloque l'assignation si le poste n'existe pas", async () => {
    repository.findPositionById.mockResolvedValue(null);
    repository.canReceivePositionAssignment.mockResolvedValue(true);

    const service = new PermissionsService(repository as never);

    await expect(
      service.assignPosition({
        positionId: 'pos-999',
        userId: 'user-1',
        assignedBy: 'director-1',
      })
    ).rejects.toMatchObject<Partial<PermissionsModuleError>>({
      code: 'POSITION_NOT_FOUND',
      statusCode: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 4 : resolveEffectivePermissions
// ---------------------------------------------------------------------------
describe('permissions.service resolveEffectivePermissions', () => {
  it('director sans can_edit_sms_template → settings.sms_templates absent', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({ can_edit_sms_template: false });

    const result = await resolveEffectivePermissions(repository as never, {
      sub: 'dir-1',
      role: 'director',
      schemaName: 'school_sainte_marie',
    });

    expect(result).not.toContain('settings.sms_templates');
  });

  it('director avec can_edit_sms_template → settings.sms_templates présent', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({
      can_edit_sms_template: true,
      monetize_parent_alerts: false,
    });

    const result = await resolveEffectivePermissions(repository as never, {
      sub: 'dir-1',
      role: 'director',
      schemaName: 'school_sainte_marie',
    });

    expect(result).toContain('settings.sms_templates');
  });

  it('director sans monetize_parent_alerts → permissions abonnements absentes', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({
      can_edit_sms_template: false,
      monetize_parent_alerts: false,
    });

    const result = await resolveEffectivePermissions(repository as never, {
      sub: 'dir-1',
      role: 'director',
      schemaName: 'school_sainte_marie',
    });

    expect(result).not.toContain('subscriptions.view');
    expect(result).not.toContain('subscriptions.edit');
    expect(result).not.toContain('subscriptions.password.reset');
    expect(result).not.toContain('subscriptions.revenue');
  });

  it('director avec monetize_parent_alerts → permissions abonnements présentes', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({
      can_edit_sms_template: false,
      monetize_parent_alerts: true,
    });

    const result = await resolveEffectivePermissions(repository as never, {
      sub: 'dir-1',
      role: 'director',
      schemaName: 'school_sainte_marie',
    });

    expect(result).toContain('subscriptions.view');
    expect(result).toContain('subscriptions.edit');
    expect(result).toContain('subscriptions.password.reset');
    expect(result).toContain('subscriptions.revenue');
  });

  it('staff avec postes assignés → cumule les permissions des postes', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({
      can_edit_sms_template: false,
      monetize_parent_alerts: false,
    });
    repository.listAssignedPermissions.mockResolvedValue(['teachers.view', 'students.view']);

    const result = await resolveEffectivePermissions(repository as never, {
      sub: 'staff-1',
      role: 'staff',
      schemaName: 'school_sainte_marie',
    });

    expect(result).toContain('teachers.view');
    expect(result).toContain('students.view');
  });

  it('staff sans monetize_parent_alerts → permissions abonnements assignées retirées', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({
      can_edit_sms_template: false,
      monetize_parent_alerts: false,
    });
    repository.listAssignedPermissions.mockResolvedValue(['teachers.view', 'subscriptions.view']);

    const result = await resolveEffectivePermissions(repository as never, {
      sub: 'staff-1',
      role: 'staff',
      schemaName: 'school_sainte_marie',
    });

    expect(result).toContain('teachers.view');
    expect(result).not.toContain('subscriptions.view');
  });

  it('staff sans poste → aucune permission', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({
      can_edit_sms_template: false,
      monetize_parent_alerts: false,
    });
    repository.listAssignedPermissions.mockResolvedValue([]);

    const result = await resolveEffectivePermissions(repository as never, {
      sub: 'staff-1',
      role: 'staff',
      schemaName: 'school_sainte_marie',
    });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 : resetAdministrativeUserPassword
// ---------------------------------------------------------------------------
describe('permissions.service resetAdministrativeUserPassword', () => {
  it('réinitialise le mot de passe avec succès', async () => {
    repository.findAdministrativeUserById.mockResolvedValue({
      id: 'user-1',
      name: 'Staff',
      role: 'staff',
    });
    repository.updateAdministrativeUserPasswordHash.mockResolvedValue(undefined);

    const service = new PermissionsService(repository as never);
    const result = await service.resetAdministrativeUserPassword('user-1', {
      newPassword: 'NewPass123',
    });

    expect(result).toEqual({ updated: true });
    expect(repository.updateAdministrativeUserPasswordHash).toHaveBeenCalledWith(
      'user-1',
      expect.any(String)
    );
  });

  it("échoue si l'utilisateur n'existe pas", async () => {
    repository.findAdministrativeUserById.mockResolvedValue(null);

    const service = new PermissionsService(repository as never);

    await expect(
      service.resetAdministrativeUserPassword('user-999', { newPassword: 'NewPass123' })
    ).rejects.toMatchObject<Partial<PermissionsModuleError>>({
      code: 'ADMIN_USER_NOT_FOUND',
      statusCode: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 6 : withSmsTemplatePermissionGuard (via createPosition)
// ---------------------------------------------------------------------------
describe('permissions.service withSmsTemplatePermissionGuard (via createPosition)', () => {
  it('ne sauvegarde pas settings.sms_templates si can_edit_sms_template est false', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({ can_edit_sms_template: false });
    repository.createPosition.mockResolvedValue({
      id: 'pos-1',
      name: 'Poste Test',
      permissions: ['teachers.view'],
    });

    const service = new PermissionsService(repository as never);
    await service.createPosition({
      name: 'Poste Test',
      permissions: ['teachers.view', 'settings.sms_templates'],
      createdBy: 'dir-1',
      schemaName: 'school_sainte_marie',
    });

    expect(repository.createPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: expect.not.arrayContaining(['settings.sms_templates']),
      })
    );
  });

  it('sauvegarde settings.sms_templates si can_edit_sms_template est true', async () => {
    repository.getSchoolConfigBySchemaName.mockResolvedValue({ can_edit_sms_template: true });
    repository.createPosition.mockResolvedValue({
      id: 'pos-2',
      name: 'Poste Test',
      permissions: ['teachers.view', 'settings.sms_templates'],
    });

    const service = new PermissionsService(repository as never);
    await service.createPosition({
      name: 'Poste Test',
      permissions: ['teachers.view', 'settings.sms_templates'],
      createdBy: 'dir-1',
      schemaName: 'school_sainte_marie',
    });

    expect(repository.createPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: expect.arrayContaining(['settings.sms_templates']),
      })
    );
  });
});
