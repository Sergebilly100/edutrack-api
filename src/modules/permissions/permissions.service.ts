import argon2 from 'argon2';

import type { AccessTokenClaims } from '../auth/auth.service.js';

import { PermissionsRepository } from './permissions.repository.js';
import { PERMISSION_KEYS, STAFF_BASE_PERMISSIONS } from './permissions.types.js';
import type { PermissionKey } from '../../shared/types/index.js';
import {
  buildUsersLimitReachedMessage,
  getMaxUsersBySchemaName,
} from '../../shared/utils/users-limit.js';

const ALL_PERMISSIONS_SET = new Set<PermissionKey>(PERMISSION_KEYS);
const STAFF_BASE_PERMISSIONS_SET = new Set<PermissionKey>(STAFF_BASE_PERMISSIONS);

const dedupePermissions = (permissions: readonly PermissionKey[]): PermissionKey[] => {
  const uniq = new Set<PermissionKey>(permissions);
  return PERMISSION_KEYS.filter((key) => uniq.has(key));
};

const baseRolePermissions = (role: AccessTokenClaims['role']): Set<PermissionKey> => {
  if (role === 'director' || role === 'super_admin') {
    return new Set(ALL_PERMISSIONS_SET);
  }

  if (role === 'staff') {
    return new Set(STAFF_BASE_PERMISSIONS_SET);
  }

  return new Set();
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
        logoUrl: schoolConfig.logo_url,
        activeSchoolYear: schoolConfig.active_school_year,
      },
      limits: {
        maxAdminPositions: schoolConfig.max_admin_positions,
      },
      positions,
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
    }
  ) {
    await this.repository.updateSchoolConfig(schemaName, input);
    return this.getConfig(schemaName);
  }

  async updateLimits(schemaName: string, input: { maxAdminPositions: number }) {
    await this.repository.updateMaxAdminPositions(schemaName, input.maxAdminPositions);
    return this.getConfig(schemaName);
  }

  async listPositions() {
    const positions = await this.repository.listPositions();
    return { positions };
  }

  async createPosition(input: { name: string; permissions: PermissionKey[]; createdBy: string }) {
    const position = await this.repository.createPosition({
      name: input.name,
      permissions: dedupePermissions(input.permissions),
      createdBy: input.createdBy,
    });

    return { position };
  }

  async updatePosition(
    positionId: string,
    input: { name?: string; permissions?: PermissionKey[] }
  ) {
    const position = await this.repository.updatePosition(positionId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.permissions !== undefined
        ? { permissions: dedupePermissions(input.permissions) }
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
    const [currentCount, maxUsers] = await Promise.all([
      this.repository.countActiveUsers(),
      getMaxUsersBySchemaName(context.schemaName),
    ]);

    if (currentCount >= maxUsers) {
      throw new PermissionsModuleError(
        buildUsersLimitReachedMessage(currentCount, maxUsers),
        403,
        'USERS_LIMIT_REACHED'
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
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : '';
      const constraint =
        typeof error === 'object' && error !== null && 'constraint' in error
          ? String((error as { constraint: unknown }).constraint)
          : '';

      if (code === '23505' && constraint.includes('users_email_unique')) {
        throw new PermissionsModuleError('Cet email est déjà utilisé', 409, 'EMAIL_ALREADY_USED');
      }

      if (code === '23505' && constraint.includes('users_phone_unique')) {
        throw new PermissionsModuleError('Ce numéro est déjà utilisé', 409, 'PHONE_ALREADY_USED');
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
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : '';
      const constraint =
        typeof error === 'object' && error !== null && 'constraint' in error
          ? String((error as { constraint: unknown }).constraint)
          : '';

      if (code === '23505' && constraint.includes('users_email_unique')) {
        throw new PermissionsModuleError('Cet email est déjà utilisé', 409, 'EMAIL_ALREADY_USED');
      }

      if (code === '23505' && constraint.includes('users_phone_unique')) {
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

  async resetAdministrativeUserPassword(userId: string, input: { newPassword: string }) {
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
    return { updated: true };
  }

  async getEffectivePermissions(claims: Pick<AccessTokenClaims, 'sub' | 'role'>) {
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
  claims: Pick<AccessTokenClaims, 'sub' | 'role'>
): Promise<PermissionKey[]> => {
  const rolePermissions = baseRolePermissions(claims.role);
  if (claims.role === 'director' || claims.role === 'super_admin') {
    return dedupePermissions([...rolePermissions]);
  }

  const assignedPermissions = await repository.listAssignedPermissions(claims.sub);
  const effective = new Set<PermissionKey>([...rolePermissions, ...assignedPermissions]);
  return dedupePermissions([...effective]);
};

export const buildPermissionsService = (db: ConstructorParameters<typeof PermissionsRepository>[0]) =>
  new PermissionsService(new PermissionsRepository(db));
