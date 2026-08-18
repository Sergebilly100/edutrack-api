import { AcademicRepository } from './academic.repository.js';
import {
  getSchoolYearConsistencyIssue,
  type CreateClassInput,
  type CreateLevelInput,
  type CreateSchoolYearInput,
  type SchoolYearConsistencyInput,
  type UpdateClassInput,
  type UpdateLevelInput,
  type UpdateSchoolYearInput,
} from './academic.types.js';

export class AcademicModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'AcademicModuleError';
  }
}

const getDbError = (error: unknown): { code: string; constraint: string } => {
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      break;
    }

    const code = 'code' in current ? String((current as { code?: unknown }).code ?? '') : '';
    if (code) {
      return {
        code,
        constraint:
          'constraint' in current
            ? String((current as { constraint?: unknown }).constraint ?? '')
            : '',
      };
    }

    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }

  return { code: '', constraint: '' };
};

const assertSchoolYearConsistency = (input: SchoolYearConsistencyInput): void => {
  const issue = getSchoolYearConsistencyIssue(input);
  if (issue) {
    throw new AcademicModuleError(issue, 400, 'INVALID_SCHOOL_YEAR');
  }
};

export class AcademicService {
  constructor(private readonly repository: AcademicRepository) {}

  async listSchoolYears() {
    return { schoolYears: await this.repository.listSchoolYears() };
  }

  async createSchoolYear(input: CreateSchoolYearInput) {
    assertSchoolYearConsistency(input);

    try {
      return await this.repository.createSchoolYear(input);
    } catch (error) {
      const dbError = getDbError(error);
      if (
        dbError.code === '23505' &&
        dbError.constraint === 'school_years_one_active_idx'
      ) {
        throw new AcademicModuleError(
          'Only one school year can be active',
          409,
          'ACTIVE_SCHOOL_YEAR_CONFLICT'
        );
      }
      if (dbError.code === '23505') {
        throw new AcademicModuleError(
          'School year already exists',
          409,
          'SCHOOL_YEAR_CONFLICT'
        );
      }
      throw error;
    }
  }

  async updateSchoolYear(id: string, input: UpdateSchoolYearInput) {
    const current = await this.repository.findSchoolYearById(id);
    if (!current) {
      throw new AcademicModuleError('School year not found', 404, 'SCHOOL_YEAR_NOT_FOUND');
    }

    assertSchoolYearConsistency({
      label: input.label ?? current.label,
      startDate: input.startDate ?? current.startDate,
      endDate: input.endDate ?? current.endDate,
    });

    try {
      const updated = await this.repository.updateSchoolYear(id, input);
      if (!updated) {
        throw new AcademicModuleError('School year not found', 404, 'SCHOOL_YEAR_NOT_FOUND');
      }
      return updated;
    } catch (error) {
      if (error instanceof AcademicModuleError) {
        throw error;
      }

      const dbError = getDbError(error);
      if (
        dbError.code === '23505' &&
        dbError.constraint === 'school_years_one_active_idx'
      ) {
        throw new AcademicModuleError(
          'Only one school year can be active',
          409,
          'ACTIVE_SCHOOL_YEAR_CONFLICT'
        );
      }
      if (dbError.code === '23505') {
        throw new AcademicModuleError(
          'School year already exists',
          409,
          'SCHOOL_YEAR_CONFLICT'
        );
      }
      throw error;
    }
  }

  async deleteSchoolYear(id: string) {
    const current = await this.repository.findSchoolYearById(id);
    if (!current) {
      throw new AcademicModuleError('School year not found', 404, 'SCHOOL_YEAR_NOT_FOUND');
    }
    if (current.status === 'active') {
      throw new AcademicModuleError(
        'An active school year cannot be deleted',
        409,
        'ACTIVE_SCHOOL_YEAR_DELETE_FORBIDDEN'
      );
    }

    try {
      const deleted = await this.repository.deleteSchoolYear(id);
      if (!deleted) {
        throw new AcademicModuleError(
          'An active school year cannot be deleted',
          409,
          'ACTIVE_SCHOOL_YEAR_DELETE_FORBIDDEN'
        );
      }
      return deleted;
    } catch (error) {
      if (error instanceof AcademicModuleError) {
        throw error;
      }
      if (getDbError(error).code === '23503') {
        throw new AcademicModuleError(
          'School year is used by classes and cannot be deleted',
          409,
          'SCHOOL_YEAR_IN_USE'
        );
      }
      throw error;
    }
  }

  async listLevels() {
    return { levels: await this.repository.listLevels() };
  }

  async createLevel(input: CreateLevelInput) {
    try {
      return await this.repository.createLevel(input);
    } catch (error) {
      if (getDbError(error).code === '23505') {
        throw new AcademicModuleError('Level already exists', 409, 'LEVEL_CONFLICT');
      }
      throw error;
    }
  }

  async updateLevel(id: string, input: UpdateLevelInput) {
    try {
      const level = await this.repository.updateLevel(id, input);
      if (!level) {
        throw new AcademicModuleError('Level not found', 404, 'LEVEL_NOT_FOUND');
      }
      return level;
    } catch (error) {
      if (error instanceof AcademicModuleError) {
        throw error;
      }
      if (getDbError(error).code === '23505') {
        throw new AcademicModuleError('Level already exists', 409, 'LEVEL_CONFLICT');
      }
      throw error;
    }
  }

  async deleteLevel(id: string) {
    try {
      const level = await this.repository.deleteLevel(id);
      if (!level) {
        throw new AcademicModuleError('Level not found', 404, 'LEVEL_NOT_FOUND');
      }
      return level;
    } catch (error) {
      if (error instanceof AcademicModuleError) {
        throw error;
      }
      if (getDbError(error).code === '23503') {
        throw new AcademicModuleError(
          'Level is used by classes and cannot be deleted',
          409,
          'LEVEL_IN_USE'
        );
      }
      throw error;
    }
  }

  private async assertClassReferences(input: {
    levelId?: string;
    homeroomTeacherId?: string | null;
  }): Promise<void> {
    if (input.levelId) {
      const level = await this.repository.findLevelById(input.levelId);
      if (!level) {
        throw new AcademicModuleError('Level not found', 400, 'CLASS_LEVEL_NOT_FOUND');
      }
    }

    if (input.homeroomTeacherId) {
      const exists = await this.repository.teacherExists(input.homeroomTeacherId);
      if (!exists) {
        throw new AcademicModuleError(
          'Homeroom teacher not found',
          400,
          'HOMEROOM_TEACHER_NOT_FOUND'
        );
      }
    }
  }

  async listClassesForActiveYear() {
    const [activeSchoolYear, classes] = await Promise.all([
      this.repository.getActiveSchoolYear(),
      this.repository.listClassesForActiveYear(),
    ]);
    return { activeSchoolYear, classes };
  }

  async createClass(input: CreateClassInput) {
    await this.assertClassReferences(input);

    try {
      const created = await this.repository.createClassForActiveYear(input);
      if (!created) {
        throw new AcademicModuleError(
          'No active school year is configured',
          409,
          'ACTIVE_SCHOOL_YEAR_REQUIRED'
        );
      }
      return created;
    } catch (error) {
      if (error instanceof AcademicModuleError) {
        throw error;
      }
      const dbError = getDbError(error);
      if (dbError.code === '23505') {
        throw new AcademicModuleError(
          'An active class with this name already exists for the school year',
          409,
          'CLASS_CONFLICT'
        );
      }
      if (dbError.code === '23503') {
        throw new AcademicModuleError('Invalid class reference', 400, 'INVALID_CLASS_REFERENCE');
      }
      throw error;
    }
  }

  async updateClass(id: string, input: UpdateClassInput) {
    const activeSchoolYear = await this.repository.getActiveSchoolYear();
    if (!activeSchoolYear) {
      throw new AcademicModuleError(
        'No active school year is configured',
        409,
        'ACTIVE_SCHOOL_YEAR_REQUIRED'
      );
    }
    await this.assertClassReferences(input);

    try {
      const updated = await this.repository.updateClassForActiveYear(id, input);
      if (!updated) {
        throw new AcademicModuleError(
          'Active class not found for the current school year',
          404,
          'CLASS_NOT_FOUND'
        );
      }
      return updated;
    } catch (error) {
      if (error instanceof AcademicModuleError) {
        throw error;
      }
      const dbError = getDbError(error);
      if (dbError.code === '23505') {
        throw new AcademicModuleError(
          'An active class with this name already exists for the school year',
          409,
          'CLASS_CONFLICT'
        );
      }
      if (dbError.code === '23503') {
        throw new AcademicModuleError('Invalid class reference', 400, 'INVALID_CLASS_REFERENCE');
      }
      throw error;
    }
  }

  async archiveClass(id: string) {
    const activeSchoolYear = await this.repository.getActiveSchoolYear();
    if (!activeSchoolYear) {
      throw new AcademicModuleError(
        'No active school year is configured',
        409,
        'ACTIVE_SCHOOL_YEAR_REQUIRED'
      );
    }

    const archived = await this.repository.archiveClassForActiveYear(id);
    if (!archived) {
      throw new AcademicModuleError(
        'Active class not found for the current school year',
        404,
        'CLASS_NOT_FOUND'
      );
    }
    return archived;
  }
}

export const buildAcademicService = (
  db: ConstructorParameters<typeof AcademicRepository>[0]
): AcademicService => new AcademicService(new AcademicRepository(db));
