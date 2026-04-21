import type { AccessTokenClaims } from '../auth/auth.service.js';

import { PermissionsRepository } from './permissions.repository.js';
import { PERMISSION_KEYS, SECRETARY_BASE_PERMISSIONS } from './permissions.types.js';
import type { PermissionKey } from '../../shared/types/index.js';

const ALL_PERMISSIONS_SET = new Set<PermissionKey>(PERMISSION_KEYS);
const SECRETARY_BASE_PERMISSIONS_SET = new Set<PermissionKey>(SECRETARY_BASE_PERMISSIONS);

const dedupePermissions = (permissions: readonly PermissionKey[]): PermissionKey[] => {
  const uniq = new Set<PermissionKey>(permissions);
  return PERMISSION_KEYS.filter((key) => uniq.has(key));
};

const baseRolePermissions = (role: AccessTokenClaims['role']): Set<PermissionKey> => {
  if (role === 'director' || role === 'super_admin') {
    return new Set(ALL_PERMISSIONS_SET);
  }

  if (role === 'secretary') {
    return new Set(SECRETARY_BASE_PERMISSIONS_SET);
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
    const [position, userExists] = await Promise.all([
      this.repository.findPositionById(input.positionId),
      this.repository.userExists(input.userId),
    ]);

    if (!position) {
      throw new PermissionsModuleError('Position not found', 404, 'POSITION_NOT_FOUND');
    }

    if (!userExists) {
      throw new PermissionsModuleError('User not found', 404, 'USER_NOT_FOUND');
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
