import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcademicRepository } from '../../src/modules/academic/academic.repository.js';
import {
  AcademicModuleError,
  AcademicService,
} from '../../src/modules/academic/academic.service.js';
import {
  createSchoolYearBodySchema,
  getDefaultEndOfYearReviewStartDate,
  getSchoolYearConsistencyIssue,
} from '../../src/modules/academic/academic.types.js';

const activeSchoolYear = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  label: '09/2026 - 06/2027',
  startDate: '2026-09-01',
  endDate: '2027-06-30',
  endOfYearReviewStartDate: '2027-05-31',
  status: 'active' as const,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
};

const level = {
  id: '550e8400-e29b-41d4-a716-446655440002',
  name: '6ème',
  orderIndex: 7,
  isExamClass: false,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
};

const mockRepository = {
  listSchoolYears: vi.fn(),
  findSchoolYearById: vi.fn(),
  getActiveSchoolYear: vi.fn(),
  createSchoolYear: vi.fn(),
  updateSchoolYear: vi.fn(),
  deleteSchoolYear: vi.fn(),
  listLevels: vi.fn(),
  findLevelById: vi.fn(),
  createLevel: vi.fn(),
  updateLevel: vi.fn(),
  deleteLevel: vi.fn(),
  teacherExists: vi.fn(),
  adoptLegacyClassesForSchoolYear: vi.fn(),
  listClassesBySchoolYear: vi.fn(),
  createClassForActiveYear: vi.fn(),
  updateClassForActiveYear: vi.fn(),
  archiveClassForActiveYear: vi.fn(),
} as unknown as Record<keyof AcademicRepository, ReturnType<typeof vi.fn>>;

const service = new AcademicService(mockRepository as unknown as AcademicRepository);

beforeEach(() => {
  vi.clearAllMocks();
  mockRepository.findLevelById.mockResolvedValue(level);
  mockRepository.getActiveSchoolYear.mockResolvedValue(activeSchoolYear);
});

describe('academic school year validation', () => {
  it('calcule la date de revue par défaut trente jours avant la fin', () => {
    expect(getDefaultEndOfYearReviewStartDate('2027-06-30')).toBe('2027-05-31');
  });

  it('accepte un libellé MM/YYYY cohérent avec les dates', () => {
    const parsed = createSchoolYearBodySchema.parse({
      label: '09/2026 - 06/2027',
      startDate: '2026-09-01',
      endDate: '2027-06-30',
      status: 'draft',
    });

    expect(parsed.label).toBe('09/2026 - 06/2027');
  });

  it('refuse une date de début postérieure à la date de fin', () => {
    expect(
      getSchoolYearConsistencyIssue({
        label: '09/2027 - 06/2027',
        startDate: '2027-09-01',
        endDate: '2027-06-30',
      })
    ).toBe('School year start date must be before end date');
  });

  it('refuse un libellé qui ne correspond pas aux mois des dates', () => {
    const result = createSchoolYearBodySchema.safeParse({
      label: '08/2026 - 06/2027',
      startDate: '2026-09-01',
      endDate: '2027-06-30',
      status: 'draft',
    });

    expect(result.success).toBe(false);
  });

  it('refuse une date civile inexistante', () => {
    const result = createSchoolYearBodySchema.safeParse({
      label: '02/2026 - 06/2027',
      startDate: '2026-02-31',
      endDate: '2027-06-30',
      status: 'draft',
    });

    expect(result.success).toBe(false);
  });
});

describe('academic.service', () => {
  it("liste les classes de l'année scolaire demandée", async () => {
    mockRepository.findSchoolYearById.mockResolvedValue(activeSchoolYear);
    mockRepository.listClassesBySchoolYear.mockResolvedValue([]);

    const result = await service.listClasses(activeSchoolYear.id);

    expect(mockRepository.listClassesBySchoolYear).toHaveBeenCalledWith(activeSchoolYear.id);
    expect(mockRepository.adoptLegacyClassesForSchoolYear).toHaveBeenCalledWith(activeSchoolYear.id);
    expect(result).toMatchObject({
      schoolYear: activeSchoolYear,
      activeSchoolYear,
      classes: [],
    });
  });

  it("unifie les classes historiques avant de lister les niveaux", async () => {
    mockRepository.listLevels.mockResolvedValue([level]);

    const result = await service.listLevels();

    expect(mockRepository.adoptLegacyClassesForSchoolYear).toHaveBeenCalledWith(activeSchoolYear.id);
    expect(result).toEqual({ levels: [level] });
  });

  it("signale une année scolaire inconnue lors du filtrage des classes", async () => {
    mockRepository.findSchoolYearById.mockResolvedValue(null);

    await expect(
      service.listClasses('550e8400-e29b-41d4-a716-446655440099')
    ).rejects.toMatchObject<Partial<AcademicModuleError>>({
      statusCode: 404,
      code: 'SCHOOL_YEAR_NOT_FOUND',
    });
    expect(mockRepository.listClassesBySchoolYear).not.toHaveBeenCalled();
  });

  it("traduit la contrainte d'unicité d'année active en conflit métier", async () => {
    const error = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'school_years_one_active_idx',
    });
    mockRepository.createSchoolYear.mockRejectedValue(error);

    await expect(
      service.createSchoolYear({
        label: '09/2026 - 06/2027',
        startDate: '2026-09-01',
        endDate: '2027-06-30',
        status: 'active',
      })
    ).rejects.toMatchObject<Partial<AcademicModuleError>>({
      statusCode: 409,
      code: 'ACTIVE_SCHOOL_YEAR_CONFLICT',
    });
  });

  it("refuse une date de revue égale ou postérieure à la fin de l'année", async () => {
    mockRepository.findSchoolYearById.mockResolvedValue(activeSchoolYear);

    await expect(
      service.updateSchoolYear(activeSchoolYear.id, { endOfYearReviewStartDate: '2027-06-30' })
    ).rejects.toMatchObject<Partial<AcademicModuleError>>({
      statusCode: 400,
      code: 'INVALID_SCHOOL_YEAR',
    });
    expect(mockRepository.updateSchoolYear).not.toHaveBeenCalled();
  });

  it("refuse la création d'une classe lorsqu'aucune année n'est active", async () => {
    mockRepository.createClassForActiveYear.mockResolvedValue(null);

    await expect(
      service.createClass({ name: '6ème A', levelId: level.id, homeroomTeacherId: null })
    ).rejects.toMatchObject<Partial<AcademicModuleError>>({
      statusCode: 409,
      code: 'ACTIVE_SCHOOL_YEAR_REQUIRED',
    });
  });

  it('refuse un professeur principal inexistant', async () => {
    mockRepository.teacherExists.mockResolvedValue(false);

    await expect(
      service.createClass({
        name: '6ème A',
        levelId: level.id,
        homeroomTeacherId: '550e8400-e29b-41d4-a716-446655440003',
      })
    ).rejects.toMatchObject<Partial<AcademicModuleError>>({
      statusCode: 400,
      code: 'HOMEROOM_TEACHER_NOT_FOUND',
    });
    expect(mockRepository.createClassForActiveYear).not.toHaveBeenCalled();
  });
});
