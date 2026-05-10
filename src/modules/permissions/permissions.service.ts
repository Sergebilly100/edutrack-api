import argon2 from 'argon2';

import { PermissionsRepository } from './permissions.repository.js';
import { recordPasswordReset } from '../../shared/auth/token-version.js';

type ClaimsCoreFields = {
  sub: string;
  role: 'director' | 'super_admin' | 'staff' | 'teacher' | 'parent';
  schemaName: string;
};
import { PERMISSION_KEYS, STAFF_BASE_PERMISSIONS } from './permissions.types.js';
import type { PermissionKey } from '../../shared/types/index.js';
import { getPlanLimitsBySchemaName } from '../../shared/utils/users-limit.js';

const extractDbError = (error: unknown): { code: string; constraint: string; detail: string } => {
  if (typeof error !== 'object' || error === null) {
    return { code: '', constraint: '', detail: '' };
  }
  return {
    code: 'code' in error ? String((error as { code: unknown }).code) : '',
    constraint: 'constraint' in error ? String((error as { constraint: unknown }).constraint) : '',
    detail: 'detail' in error ? String((error as { detail: unknown }).detail) : '',
  };
};

const ALL_PERMISSIONS_SET = new Set<PermissionKey>(PERMISSION_KEYS);
const STAFF_BASE_PERMISSIONS_SET = new Set<PermissionKey>(STAFF_BASE_PERMISSIONS);
const SMS_TEMPLATE_PERMISSION: PermissionKey = 'settings.sms_templates';

const dedupePermissions = (permissions: readonly PermissionKey[]): PermissionKey[] => {
  const uniq = new Set<PermissionKey>(permissions);
  return PERMISSION_KEYS.filter((key) => uniq.has(key));
};

const baseRolePermissions = (role: ClaimsCoreFields['role']): Set<PermissionKey> => {
  if (role === 'director' || role === 'super_admin') {
    return new Set(ALL_PERMISSIONS_SET);
  }

  if (role === 'staff') {
    return new Set(STAFF_BASE_PERMISSIONS_SET);
  }

  return new Set();
};

const withSmsTemplatePermissionGuard = (
  permissions: readonly PermissionKey[],
  canEditSmsTemplate: boolean
): PermissionKey[] => {
  if (canEditSmsTemplate) {
    return dedupePermissions(permissions);
  }

  return dedupePermissions(
    permissions.filter((permission) => permission !== SMS_TEMPLATE_PERMISSION)
  );
};

export class PermissionsModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'PermissionsModuleError';
  }
}

export class PermissionsService {
  constructor(private readonly repository: PermissionsRepository) {}

  async getConfig(schemaName: string) {
    const [schoolConfig, positions, users, currentUsers, adminUsersCount] = await Promise.all([
      this.repository.getSchoolConfigBySchemaName(schemaName),
      this.repository.listPositions(),
      this.repository.listAdministrativeUsers(),
      this.repository.countActiveUsers(),
      this.repository.countActiveAdministrativeUsers(),
    ]);

    if (!schoolConfig) {
      throw new PermissionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }

    return {
      school: {
        name: schoolConfig.name,
        subdomain: schoolConfig.subdomain,
        plan: schoolConfig.plan,
        city: schoolConfig.city ?? '',
        teachingType: schoolConfig.teaching_type ?? 'general',
        maxUsers: schoolConfig.max_users,
        currentUsers: adminUsersCount,
        totalUsers: currentUsers,
        adminUsersCount,
        canEditSmsTemplate: schoolConfig.can_edit_sms_template,
        allowTeacherQrSkip: schoolConfig.allow_teacher_qr_skip,
        logoUrl: schoolConfig.logo_url,
        activeSchoolYear: schoolConfig.active_school_year,
      },
      limits: {
        maxAdminPositions: schoolConfig.max_admin_positions,
      },
      positions: positions.map((position) => ({
        ...position,
        permissions: withSmsTemplatePermissionGuard(
          position.permissions,
          schoolConfig.can_edit_sms_template
        ),
      })),
      users,
    };
  }

  async updateSchoolConfig(
    schemaName: string,
    input: {
      name?: string;
      city?: string;
      teachingType?: string;
      logoUrl?: string | null;
      activeSchoolYear?: string | null;
      allowTeacherQrSkip?: boolean;
    }
  ) {
    await this.repository.updateSchoolConfig(schemaName, input);
    return this.getConfig(schemaName);
  }

  async updateLimits(schemaName: string, input: { maxAdminPositions: number }) {
    await this.repository.updateMaxAdminPositions(schemaName, input.maxAdminPositions);
    return this.getConfig(schemaName);
  }

  async listPositions(schemaName: string) {
    const schoolConfig = await this.repository.getSchoolConfigBySchemaName(schemaName);
    if (!schoolConfig) {
      throw new PermissionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }

    const positions = await this.repository.listPositions();
    return {
      positions: positions.map((position) => ({
        ...position,
        permissions: withSmsTemplatePermissionGuard(
          position.permissions,
          schoolConfig.can_edit_sms_template
        ),
      })),
    };
  }

  async createPosition(input: {
    name: string;
    permissions: PermissionKey[];
    createdBy: string;
    schemaName: string;
  }) {
    const schoolConfig = await this.repository.getSchoolConfigBySchemaName(input.schemaName);
    if (!schoolConfig) {
      throw new PermissionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }

    const position = await this.repository.createPosition({
      name: input.name,
      permissions: withSmsTemplatePermissionGuard(
        input.permissions,
        schoolConfig.can_edit_sms_template
      ),
      createdBy: input.createdBy,
    });

    return { position };
  }

  async updatePosition(
    positionId: string,
    input: { name?: string; permissions?: PermissionKey[]; schemaName: string }
  ) {
    const schoolConfig = await this.repository.getSchoolConfigBySchemaName(input.schemaName);
    if (!schoolConfig) {
      throw new PermissionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }

    const position = await this.repository.updatePosition(positionId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.permissions !== undefined
        ? {
            permissions: withSmsTemplatePermissionGuard(
              input.permissions,
              schoolConfig.can_edit_sms_template
            ),
          }
        : {}),
    });

    if (!position) {
      throw new PermissionsModuleError('Position not found', 404, 'POSITION_NOT_FOUND');
    }

    return { position };
  }

  async deletePosition(positionId: string) {
    const existingPosition = await this.repository.findPositionById(positionId);
    if (!existingPosition) {
      throw new PermissionsModuleError('Position not found', 404, 'POSITION_NOT_FOUND');
    }

    if (existingPosition.assignmentsCount > 0) {
      throw new PermissionsModuleError(
        'Position has active assignments',
        409,
        'POSITION_HAS_ASSIGNMENTS'
      );
    }

    await this.repository.deletePosition(positionId);
    return { deleted: true };
  }

  async assignPosition(input: {
    positionId: string;
    userId: string;
    assignedBy: string;
  }) {
    const [position, userAssignable] = await Promise.all([
      this.repository.findPositionById(input.positionId),
      this.repository.canReceivePositionAssignment(input.userId),
    ]);

    if (!position) {
      throw new PermissionsModuleError('Position not found', 404, 'POSITION_NOT_FOUND');
    }

    if (!userAssignable) {
      throw new PermissionsModuleError(
        'Only active administrative users can be assigned to a position',
        400,
        'INVALID_ASSIGNMENT_TARGET'
      );
    }

    await this.repository.assignPosition({
      positionId: input.positionId,
      userId: input.userId,
      assignedBy: input.assignedBy,
    });

    const assignmentsCount = await this.repository.countAssignments(input.positionId);
    return { assigned: true, assignmentsCount };
  }

  async unassignPosition(positionId: string, userId: string) {
    const position = await this.repository.findPositionById(positionId);
    if (!position) {
      throw new PermissionsModuleError('Position not found', 404, 'POSITION_NOT_FOUND');
    }

    await this.repository.unassignPosition(positionId, userId);
    const assignmentsCount = await this.repository.countAssignments(positionId);
    return { removed: true, assignmentsCount };
  }

  async createAdministrativeUser(
    input: {
      name: string;
      email?: string;
      phone?: string;
      password: string;
    },
    context: { schemaName: string }
  ) {
    const [schoolConfig, planLimits, currentUsersCount, currentAdminCount] = await Promise.all([
      this.repository.getSchoolConfigBySchemaName(context.schemaName),
      getPlanLimitsBySchemaName(context.schemaName),
      this.repository.countActiveUsers(),
      this.repository.countActiveAdministrativeUsers(),
    ]);

    if (!schoolConfig) {
      throw new PermissionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }

    if (currentUsersCount >= planLimits.max_users) {
      throw new PermissionsModuleError(
        'Limite du plan atteinte',
        403,
        'PLAN_LIMIT_REACHED'
      );
    }

    if (currentAdminCount >= planLimits.max_admin_positions) {
      throw new PermissionsModuleError(
        'Limite du plan atteinte',
        403,
        'ADMIN_USERS_LIMIT_REACHED'
      );
    }

    const passwordHash = await argon2.hash(input.password);

    try {
      const user = await this.repository.createAdministrativeUser({
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        passwordHash,
      });

      return { user };
    } catch (error) {
      const dbErr = extractDbError(error);

      if (dbErr.code === '23505') {
        // tenter la réactivation d'abord
        const reactivatedUser = await this.repository.reactivateInactiveAdministrativeUserByContact({
          name: input.name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          passwordHash,
        });

        if (reactivatedUser) {
          return { user: reactivatedUser };
        }

        // l'inactif n'existait pas → conflit sur un user actif
        if (dbErr.constraint.includes('users_email_unique') || dbErr.detail.includes('(email)')) {
          throw new PermissionsModuleError('Cet email est déjà utilisé', 409, 'EMAIL_ALREADY_USED');
        }

        if (dbErr.constraint.includes('users_phone_unique') || dbErr.detail.includes('(phone)')) {
          throw new PermissionsModuleError('Ce numéro est déjà utilisé', 409, 'PHONE_ALREADY_USED');
        }

        // autre contrainte unique non identifiée
        throw new PermissionsModuleError('Un utilisateur avec ces informations existe déjà', 409, 'DUPLICATE_USER');
      }

      throw error;
    }
  }

  async updateAdministrativeUser(
    userId: string,
    input: { name?: string; email?: string | null; phone?: string | null }
  ) {
    const existingUser = await this.repository.findAdministrativeUserById(userId);
    if (!existingUser) {
      throw new PermissionsModuleError(
        'Utilisateur administratif introuvable',
        404,
        'ADMIN_USER_NOT_FOUND'
      );
    }

    try {
      const user = await this.repository.updateAdministrativeUser(userId, input);
      if (!user) {
        throw new PermissionsModuleError(
          'Utilisateur administratif introuvable',
          404,
          'ADMIN_USER_NOT_FOUND'
        );
      }

      return { user };
    } catch (error) {
      const dbErr = extractDbError(error);

      if (
        dbErr.code === '23505' &&
        (dbErr.constraint.includes('users_email_unique') || dbErr.detail.includes('(email)'))
      ) {
        throw new PermissionsModuleError('Cet email est déjà utilisé', 409, 'EMAIL_ALREADY_USED');
      }

      if (
        dbErr.code === '23505' &&
        (dbErr.constraint.includes('users_phone_unique') || dbErr.detail.includes('(phone)'))
      ) {
        throw new PermissionsModuleError('Ce numéro est déjà utilisé', 409, 'PHONE_ALREADY_USED');
      }

      throw error;
    }
  }

  async deleteAdministrativeUser(userId: string) {
    const existingUser = await this.repository.findAdministrativeUserById(userId);
    if (!existingUser) {
      throw new PermissionsModuleError(
        'Utilisateur administratif introuvable',
        404,
        'ADMIN_USER_NOT_FOUND'
      );
    }

    await this.repository.deactivateAdministrativeUser(userId);
    return { deleted: true };
  }

  async resetAdministrativeUserPassword(
    userId: string,
    input: { newPassword: string; schemaName: string }
  ) {
    const existingUser = await this.repository.findAdministrativeUserById(userId);
    if (!existingUser) {
      throw new PermissionsModuleError(
        'Utilisateur administratif introuvable',
        404,
        'ADMIN_USER_NOT_FOUND'
      );
    }

    const passwordHash = await argon2.hash(input.newPassword);
    await this.repository.updateAdministrativeUserPasswordHash(userId, passwordHash);
    await this.repository.revokeAllUserRefreshTokens(userId);
    await recordPasswordReset(input.schemaName, userId);
    return { updated: true };
  }

  async getEffectivePermissions(
    claims: Pick<ClaimsCoreFields, 'sub' | 'role' | 'schemaName'>
  ) {
    const permissions = await resolveEffectivePermissions(this.repository, claims);

    return {
      userId: claims.sub,
      role: claims.role,
      permissions,
    };
  }
}

export const resolveEffectivePermissions = async (
  repository: PermissionsRepository,
  claims: Pick<ClaimsCoreFields, 'sub' | 'role' | 'schemaName'>
): Promise<PermissionKey[]> => {
  const rolePermissions = baseRolePermissions(claims.role);
  if (claims.role === 'super_admin') {
    return dedupePermissions([...rolePermissions]);
  }

  const schoolConfig = await repository.getSchoolConfigBySchemaName(claims.schemaName);
  const canEditSmsTemplate = schoolConfig?.can_edit_sms_template ?? false;

  if (claims.role === 'director') {
    return withSmsTemplatePermissionGuard([...rolePermissions], canEditSmsTemplate);
  }

  const assignedPermissions = await repository.listAssignedPermissions(claims.sub);
  const effective = new Set<PermissionKey>([...rolePermissions, ...assignedPermissions]);
  return withSmsTemplatePermissionGuard([...effective], canEditSmsTemplate);
};

export const buildPermissionsService = (db: ConstructorParameters<typeof PermissionsRepository>[0]) =>
  new PermissionsService(new PermissionsRepository(db));
