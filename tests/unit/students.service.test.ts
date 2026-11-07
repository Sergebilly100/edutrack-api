import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureParentAccountForStudent,
  ParentAccountsRepository,
} from '../../src/modules/parents/parent-accounts.repository.js';
import {
  buildParentAccessSms,
  createTemporaryParentCredentials,
  ParentAccountsService,
} from '../../src/modules/parents/parent-accounts.service.js';
import { StudentsService } from '../../src/modules/students/students.service.js';

// ─── Repository mock ──────────────────────────────────────────────────────────

const repository = {
  listStudents: vi.fn(),
  createStudent: vi.fn(),
  findStudentDetailById: vi.fn(),
  findCurrentConfirmedSchoolYear: vi.fn(),
  findEnrollmentRepeating: vi.fn().mockResolvedValue(null),
  findLatestHistoricalConfirmedSchoolYear: vi.fn(),
  findActiveSchoolYear: vi.fn(),
  hasConfirmedEnrollmentInActiveSchoolYear: vi.fn(),
  updateStudent: vi.fn(),
  classIsInOpenSchoolYear: vi.fn(),
  softDeleteStudent: vi.fn(),
  findScheduleById: vi.fn(),
  findStudentsForAbsence: vi.fn(),
  upsertStudentAbsences: vi.fn(),
  getTenantIdBySchemaName: vi.fn(),
  getSchoolPhone: vi.fn(),
  listAttendanceHistory: vi.fn(),
  listTodayAbsences: vi.fn(),
  getStudentAbsenceStats: vi.fn(),
  getStudentAbsenceDetails: vi.fn(),
  findAbsenceById: vi.fn(),
  excuseAbsence: vi.fn(),
  teacherHasClassAccess: vi.fn(),
};

const eventEmitter = vi.fn();

const buildService = (dependencies: Record<string, unknown> = {}) =>
  new StudentsService(repository as never, { eventEmitter, ...dependencies } as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCurrentStudentProfile()', () => {
  it('refuse le dossier sans inscription confirmée dans l’année active', async () => {
    repository.findCurrentConfirmedSchoolYear.mockResolvedValue(null);
    await expect(buildService().getCurrentStudentProfile('student-1'))
      .rejects.toMatchObject({ statusCode: 404, code: 'STUDENT_NOT_CURRENTLY_ENROLLED' });
    expect(repository.findStudentDetailById).not.toHaveBeenCalled();
  });

  it('renvoie la fiche et l’année active après confirmation', async () => {
    const activeSchoolYear = { id: 'year-1', label: '2026-2027' };
    repository.findCurrentConfirmedSchoolYear.mockResolvedValue(activeSchoolYear);
    repository.findStudentDetailById.mockResolvedValue({ id: 'student-1', firstName: 'Awa' });
    await expect(buildService().getCurrentStudentProfile('student-1'))
      .resolves.toMatchObject({ id: 'student-1', activeSchoolYear });
  });

  it('ne livre pas les absences ni les pièces privées avec le seul droit de lire l’identité', async () => {
    repository.findCurrentConfirmedSchoolYear.mockResolvedValue({ id: 'year-1', label: '2026-2027' });
    repository.findStudentDetailById.mockResolvedValue({
      id: 'student-1', absenceSummary: { total: 4, excused: 0, thisMonth: 1, thisWeek: 1 },
      recentAbsences: [{ id: 'absence-1' }], parentSms: [{ id: 'sms-1' }], documents: [{ id: 'document-1' }],
    });
    await expect(buildService().getCurrentStudentProfile('student-1', { attendance: false, documents: false }))
      .resolves.toMatchObject({ absenceSummary: { total: 0, excused: 0, thisMonth: 0, thisWeek: 0 }, recentAbsences: [], parentSms: [], documents: [] });
  });
});

describe('getStudentDetail()', () => {
  it('applique les mêmes droits aux champs annexes de la fiche générique', async () => {
    repository.findStudentDetailById.mockResolvedValue({
      id: 'student-1', absenceSummary: { total: 1, excused: 0, thisMonth: 1, thisWeek: 0 },
      recentAbsences: [{ id: 'absence-1' }], parentSms: [{ id: 'sms-1' }], documents: [{ id: 'document-1' }],
    });
    await expect(buildService().getStudentDetail('student-1', { attendance: false, documents: false }))
      .resolves.toMatchObject({ recentAbsences: [], parentSms: [], documents: [], absenceSummary: { total: 0 } });
  });
});

describe('getHistoricalStudentProfile()', () => {
  it('garde accessible un dossier même sans inscription antérieure confirmée', async () => {
    repository.findLatestHistoricalConfirmedSchoolYear.mockResolvedValue(null);
    await expect(buildService().getHistoricalStudentProfile('student-1'))
      .resolves.toMatchObject({ id: 'student-1', latestConfirmedSchoolYear: null });
    expect(repository.findStudentDetailById).toHaveBeenCalledWith('student-1');
  });

  it('ouvre le dossier passé même si une réinscription en cours reste non confirmée', async () => {
    repository.findLatestHistoricalConfirmedSchoolYear.mockResolvedValue({ id: 'old-year', label: '2024-2025', className: '6e A' });
    repository.findActiveSchoolYear.mockResolvedValue({ id: 'active-year', label: '2026-2027' });
    repository.hasConfirmedEnrollmentInActiveSchoolYear.mockResolvedValue(false);
    repository.findStudentDetailById.mockResolvedValue({ id: 'student-1', documents: [{ id: 'document-1' }] });
    await expect(buildService().getHistoricalStudentProfile('student-1')).resolves.toMatchObject({
      id: 'student-1', activeSchoolYear: { label: '2026-2027' },
      latestConfirmedSchoolYear: { label: '2024-2025' }, confirmedInActiveYear: false,
      documents: [{ id: 'document-1' }],
    });
  });

  it('indique une inscription confirmée actuelle même si le profil est inactif', async () => {
    repository.findLatestHistoricalConfirmedSchoolYear.mockResolvedValue({ id: 'old-year', label: '2024-2025', className: '6e A' });
    repository.findActiveSchoolYear.mockResolvedValue({ id: 'active-year', label: '2026-2027' });
    repository.hasConfirmedEnrollmentInActiveSchoolYear.mockResolvedValue(true);
    repository.findStudentDetailById.mockResolvedValue({ id: 'student-1', isActive: false });
    await expect(buildService().getHistoricalStudentProfile('student-1'))
      .resolves.toMatchObject({ confirmedInActiveYear: true, isActive: false });
  });

  it('masque les absences, SMS et documents sans les droits de ces domaines', async () => {
    repository.findStudentDetailById.mockResolvedValue({
      id: 'student-1',
      absenceSummary: { total: 2, excused: 1, thisMonth: 1, thisWeek: 0 },
      recentAbsences: [{ id: 'absence-1' }],
      parentSms: [{ id: 'sms-1' }],
      documents: [{ id: 'document-1' }],
    });
    const profile = await buildService().getHistoricalStudentProfile('student-1', { attendance: false, documents: false });
    expect(profile).toMatchObject({ absenceSummary: { total: 0, excused: 0, thisMonth: 0, thisWeek: 0 }, recentAbsences: [], parentSms: [], documents: [] });
  });
});

// ─── listStudents ─────────────────────────────────────────────────────────────

describe('listStudents()', () => {
  it('liste les profils durables sans exiger une inscription active', async () => {
    repository.listStudents.mockResolvedValue({ rows: [{ id: 'former-student' }], total: 1 });
    await expect(buildService().listHistoryProfiles({ page: 1, limit: 20 } as never))
      .resolves.toMatchObject({ data: [{ id: 'former-student' }], pagination: { total: 1 } });
    expect(repository.listStudents).toHaveBeenCalledWith({ page: 1, limit: 20 }, 'history');
  });
  it('retourne une pagination correcte', async () => {
    repository.listStudents.mockResolvedValue({
      rows: [
        {
          id: 'student-1',
          classId: 'class-1',
          className: '6e A',
          firstName: 'Awa',
          lastName: 'Kouassi',
          parentPhone: '2250700000001',
          parentPhone2: null,
          isActive: true,
          createdAt: '2026-04-13T10:00:00.000Z',
        },
      ],
      total: 45,
    });

    const result = await buildService().listStudents({
      page: 2,
      limit: 20,
      class_id: undefined,
      is_active: undefined,
      search: undefined,
    });

    expect(result.pagination).toEqual({ page: 2, limit: 20, total: 45, totalPages: 3 });
    expect(result.data).toHaveLength(1);
  });

  it('totalPages = 0 quand total = 0', async () => {
    repository.listStudents.mockResolvedValue({ rows: [], total: 0 });
    const result = await buildService().listStudents({ page: 1, limit: 20 } as never);
    expect(result.pagination.totalPages).toBe(0);
  });
});

// ─── createStudent ────────────────────────────────────────────────────────────

describe('createStudent()', () => {
  it('refuse de rattacher un élève à une classe d’année non ouverte', async () => {
    repository.classIsInOpenSchoolYear.mockResolvedValue(false);
    await expect(buildService().createStudent({ class_id: 'future-class' } as never))
      .rejects.toMatchObject({ code: 'SCHOOL_YEAR_NOT_OPEN', statusCode: 409 });
    expect(repository.createStudent).not.toHaveBeenCalled();
  });
  it('retourne l’élève et déclenche les accès du nouveau parent', async () => {
    const notifyParentAccess = vi.fn().mockResolvedValue(undefined);
    const createParentCredentials = vi.fn().mockResolvedValue({
      plainPassword: 'ABCD234567',
      passwordHash: 'argon-hash',
    });
    const student = { id: 'student-1', firstName: 'Awa' };
    repository.createStudent.mockResolvedValue({
      student,
      parentProvisioning: {
        parentId: 'parent-1',
        fullName: 'Parent Awa',
        phone: '2250700000001',
        created: true,
        temporaryPassword: 'ABCD234567',
      },
    });

    const result = await buildService({
      notifyParentAccess,
      createParentCredentials,
    }).createStudent({} as never);

    expect(result).toBe(student);
    expect(notifyParentAccess).toHaveBeenCalledWith({
      parentId: 'parent-1',
      phone: '2250700000001',
      temporaryPassword: 'ABCD234567',
    });
  });

  it('ne fait pas échouer l’inscription si l’envoi SMS échoue', async () => {
    repository.createStudent.mockResolvedValue({
      student: { id: 'student-1' },
      parentProvisioning: {
        parentId: 'parent-1',
        phone: '2250700000001',
        created: true,
        temporaryPassword: 'ABCD234567',
      },
    });

    await expect(
      buildService({
        notifyParentAccess: vi.fn().mockRejectedValue(new Error('SMS unavailable')),
      }).createStudent({} as never)
    ).resolves.toMatchObject({ id: 'student-1' });
  });

  it('lève CLASS_NOT_FOUND sur message "Class not found"', async () => {
    repository.createStudent.mockRejectedValue(new Error('Class not found'));
    await expect(buildService().createStudent({} as never)).rejects.toMatchObject({
      code: 'CLASS_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('lève CLASS_NOT_FOUND sur erreur FK 23503', async () => {
    const fkError = Object.assign(new Error('FK'), { code: '23503' });
    repository.createStudent.mockRejectedValue(fkError);
    await expect(buildService().createStudent({} as never)).rejects.toMatchObject({
      code: 'CLASS_NOT_FOUND',
    });
  });
  it('normalise le matricule renseigné et conserve le matricule optionnel', async () => {
    repository.createStudent.mockResolvedValue({ student: { id: 'student-1' } });
    await buildService().createStudent({ matricule: ' E-001 ' } as never);
    expect(repository.createStudent).toHaveBeenCalledWith(expect.objectContaining({ matricule: 'E-001' }), expect.any(Function));
    await buildService().createStudent({ matricule: null } as never);
    expect(repository.createStudent).toHaveBeenLastCalledWith(expect.objectContaining({ matricule: null }), expect.any(Function));
  });
  it('retourne 409 si la contrainte normalisée refuse une création', async () => {
    repository.createStudent.mockRejectedValue({ cause: { code: '23505', constraint: 'students_matricule_normalized_unique' } });
    await expect(buildService().createStudent({ matricule: ' e-001 ' } as never)).rejects.toMatchObject({ code: 'MATRICULE_ALREADY_EXISTS', statusCode: 409 });
  });
});

// ─── updateStudent ────────────────────────────────────────────────────────────

describe('updateStudent()', () => {
  it('retourne 409 si la contrainte normalisée refuse une modification', async () => {
    repository.updateStudent.mockRejectedValue({ cause: { code: '23505', constraint: 'students_matricule_normalized_unique' } });
    await expect(buildService().updateStudent('s-1', { matricule: ' E-001 ' })).rejects.toMatchObject({ code: 'MATRICULE_ALREADY_EXISTS', statusCode: 409 });
    expect(repository.updateStudent).toHaveBeenCalledWith('s-1', { matricule: 'E-001' }, expect.any(Function));
  });
  it('refuse de déplacer la classe depuis le profil d’un élève inscrit', async () => {
    repository.updateStudent.mockRejectedValue(new Error('Enrollment owns class'));
    await expect(buildService().updateStudent('s-1', {})).rejects.toMatchObject({
      code: 'ENROLLMENT_CLASS_MANAGED', statusCode: 409,
    });
  });
  it('lève STUDENT_NOT_FOUND si repository retourne null', async () => {
    repository.updateStudent.mockResolvedValue(null);
    await expect(buildService().updateStudent('missing', {})).rejects.toMatchObject({
      code: 'STUDENT_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('lève CLASS_NOT_FOUND sur erreur FK 23503', async () => {
    const fkError = Object.assign(new Error('FK'), { code: '23503' });
    repository.updateStudent.mockRejectedValue(fkError);
    await expect(buildService().updateStudent('s-1', {})).rejects.toMatchObject({
      code: 'CLASS_NOT_FOUND',
    });
  });

  it('retransmet une StudentsModuleError telle quelle', async () => {
    const { StudentsModuleError } = await import(
      '../../src/modules/students/students.service.js'
    );
    const err = new StudentsModuleError('Custom', 422, 'CUSTOM');
    repository.updateStudent.mockRejectedValue(err);
    await expect(buildService().updateStudent('s-1', {})).rejects.toMatchObject({
      code: 'CUSTOM',
    });
  });
});

// ─── softDeleteStudent ────────────────────────────────────────────────────────

describe('softDeleteStudent()', () => {
  it("lève STUDENT_NOT_FOUND si l'élève est déjà inactif", async () => {
    repository.softDeleteStudent.mockResolvedValue(null);
    await expect(buildService().softDeleteStudent('student-inactive')).rejects.toMatchObject({
      code: 'STUDENT_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('retourne le record si succès', async () => {
    const record = { id: 's-1', isActive: false };
    repository.softDeleteStudent.mockResolvedValue(record);
    const result = await buildService().softDeleteStudent('s-1');
    expect(result).toBe(record);
  });
});

// ─── getStudentDetail ─────────────────────────────────────────────────────────

describe('getStudentDetail()', () => {
  it('retourne les données complètes', async () => {
    repository.findStudentDetailById.mockResolvedValue({
      id: 'student-1',
      firstName: 'Awa',
      lastName: 'Kouassi',
      className: '6e A',
      classId: 'class-1',
      isActive: true,
      parentPhone: '2250700000001',
      parentPhone2: null,
      parentName: 'Maman Awa',
      parentName2: null,
      note: 'RAS',
      createdAt: '2026-04-13T10:00:00.000Z',
      absenceSummary: { total: 3, excused: 1, thisMonth: 1, thisWeek: 0 },
      recentAbsences: [],
      documents: [],
      parentSms: [],
    });

    const result = await buildService().getStudentDetail('student-1');
    expect(result.id).toBe('student-1');
    expect(result.absenceSummary.excused).toBe(1);
    expect(repository.findStudentDetailById).toHaveBeenCalledWith('student-1');
  });

  it('lève STUDENT_NOT_FOUND si introuvable', async () => {
    repository.findStudentDetailById.mockResolvedValue(null);
    await expect(buildService().getStudentDetail('x')).rejects.toMatchObject({
      code: 'STUDENT_NOT_FOUND',
    });
  });
});

// ─── excuseAbsence ────────────────────────────────────────────────────────────

describe('excuseAbsence()', () => {
  const input = { reason: 'Certificat médical' };
  const absenceRecord = {
    id: 'att-1',
    studentId: 'student-1',
    date: '2026-04-13',
    scheduleId: 'sched-1',
    status: 'absent' as const,
  };
  const excusedRecord = {
    id: 'att-1',
    studentId: 'student-1',
    date: '2026-04-13',
    scheduleId: 'sched-1',
    status: 'excused' as const,
    excuseReason: 'Certificat médical',
    excusedAt: '2026-04-14T08:00:00.000Z',
  };

  it('excuse une absence valide', async () => {
    repository.findAbsenceById.mockResolvedValue(absenceRecord);
    repository.excuseAbsence.mockResolvedValue(excusedRecord);

    const result = await buildService().excuseAbsence('att-1', input, 'user-director');

    expect(result.status).toBe('excused');
    expect(result.excuseReason).toBe('Certificat médical');
    expect(repository.excuseAbsence).toHaveBeenCalledWith('att-1', 'Certificat médical', 'user-director');
  });

  it('lève ABSENCE_NOT_FOUND si introuvable', async () => {
    repository.findAbsenceById.mockResolvedValue(null);
    await expect(buildService().excuseAbsence('missing', input, 'user-1')).rejects.toMatchObject({
      code: 'ABSENCE_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('lève ALREADY_EXCUSED si déjà excusée', async () => {
    repository.findAbsenceById.mockResolvedValue({ ...absenceRecord, status: 'excused' });
    await expect(buildService().excuseAbsence('att-1', input, 'user-1')).rejects.toMatchObject({
      code: 'ALREADY_EXCUSED',
      statusCode: 409,
    });
  });

  it("lève INVALID_STATUS_FOR_EXCUSE si statut n'est pas absent", async () => {
    repository.findAbsenceById.mockResolvedValue({ ...absenceRecord, status: 'present' });
    await expect(buildService().excuseAbsence('att-1', input, 'user-1')).rejects.toMatchObject({
      code: 'INVALID_STATUS_FOR_EXCUSE',
      statusCode: 422,
    });
  });

  it('lève ALREADY_EXCUSED en cas de race condition (excuseAbsence retourne null)', async () => {
    repository.findAbsenceById.mockResolvedValue(absenceRecord);
    repository.excuseAbsence.mockResolvedValue(null);
    await expect(buildService().excuseAbsence('att-1', input, 'user-1')).rejects.toMatchObject({
      code: 'ALREADY_EXCUSED',
      statusCode: 409,
    });
  });
});

// ─── bulkMarkAbsences ─────────────────────────────────────────────────────────

describe('bulkMarkAbsences()', () => {
  const context = { userId: 'user-1', schemaName: 'school_test' };

  beforeEach(() => {
    repository.findScheduleById.mockResolvedValue({
      id: 'schedule-1',
      classId: 'class-1',
      subject: 'Maths',
    });
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSchoolPhone.mockResolvedValue('2250701234567');
    repository.upsertStudentAbsences.mockResolvedValue(3);
  });

  it('crée les absences et émet pour chaque élève confirmé, même avec seulement le second contact', async () => {
    repository.findStudentsForAbsence.mockResolvedValue([
      { id: 'student-1', firstName: 'Awa', parentPhone: '2250700000001', parentEmail: null },
      { id: 'student-2', firstName: 'Yao', parentPhone: null, parentPhone2: '2250700000002', parentEmail: null },
      { id: 'student-3', firstName: 'Mariam', parentPhone: '2250700000003', parentEmail: null },
    ]);

    const result = await buildService().bulkMarkAbsences(
      { scheduleId: 'schedule-1', date: '2026-04-13', absences: ['student-1', 'student-2', 'student-3'] },
      context
    );

    expect(result).toEqual({ createdAttendances: 3, emittedEvents: 3 });
    expect(repository.upsertStudentAbsences).toHaveBeenCalledWith({
      scheduleId: 'schedule-1',
      date: '2026-04-13',
      studentIds: ['student-1', 'student-2', 'student-3'],
      markedBy: 'user-1',
    });
    expect(eventEmitter).toHaveBeenCalledTimes(3);
    expect(eventEmitter).toHaveBeenNthCalledWith(
      1,
      'student.absent',
      expect.objectContaining({ tenantId: 'tenant-1', studentId: 'student-1' })
    );
    expect(eventEmitter).toHaveBeenNthCalledWith(
      2,
      'student.absent',
      expect.objectContaining({
        studentId: 'student-2',
        parentPhone: '2250700000002',
        parentPhone2: '2250700000002',
      })
    );
  });

  it('retourne 0/0 si absences est vide', async () => {
    const result = await buildService().bulkMarkAbsences(
      { scheduleId: 'schedule-1', date: '2026-04-13', absences: [] },
      context
    );
    expect(result).toEqual({ createdAttendances: 0, emittedEvents: 0 });
    expect(repository.upsertStudentAbsences).not.toHaveBeenCalled();
  });

  it('déduplique les IDs avant de les traiter', async () => {
    repository.findStudentsForAbsence.mockResolvedValue([
      { id: 'student-1', firstName: 'Awa', parentPhone: '2250700000001', parentEmail: null },
    ]);
    repository.upsertStudentAbsences.mockResolvedValue(1);

    await buildService().bulkMarkAbsences(
      { scheduleId: 'schedule-1', date: '2026-04-13', absences: ['student-1', 'student-1'] },
      context
    );

    expect(repository.findStudentsForAbsence).toHaveBeenCalledWith('class-1', ['student-1']);
  });

  it('lève SCHEDULE_NOT_FOUND si le schedule est introuvable', async () => {
    repository.findScheduleById.mockResolvedValue(null);
    await expect(
      buildService().bulkMarkAbsences(
        { scheduleId: 'missing', date: '2026-04-13', absences: ['student-1'] },
        context
      )
    ).rejects.toMatchObject({ code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
  });

  it('lève INVALID_ABSENCE_STUDENT_IDS si un ID est hors classe', async () => {
    repository.findStudentsForAbsence.mockResolvedValue([
      { id: 'student-1', firstName: 'Awa', parentPhone: '2250700000001', parentEmail: null },
    ]);

    await expect(
      buildService().bulkMarkAbsences(
        { scheduleId: 'schedule-1', date: '2026-04-13', absences: ['student-1', 'student-unknown'] },
        context
      )
    ).rejects.toMatchObject({ code: 'INVALID_ABSENCE_STUDENT_IDS', statusCode: 400 });
  });

  it('lève TENANT_NOT_FOUND si le schéma est inconnu', async () => {
    repository.findStudentsForAbsence.mockResolvedValue([
      { id: 'student-1', firstName: 'Awa', parentPhone: '2250700000001', parentEmail: null },
    ]);
    repository.getTenantIdBySchemaName.mockResolvedValue(null);

    await expect(
      buildService().bulkMarkAbsences(
        { scheduleId: 'schedule-1', date: '2026-04-13', absences: ['student-1'] },
        context
      )
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND', statusCode: 404 });
    // Upsert ne doit PAS avoir été appelé (FIX B5)
    expect(repository.upsertStudentAbsences).not.toHaveBeenCalled();
  });

  it("continue les événements suivants si l'un échoue (FIX L8)", async () => {
    repository.findStudentsForAbsence.mockResolvedValue([
      { id: 'student-1', firstName: 'Awa', parentPhone: '2250700000001', parentEmail: null },
      { id: 'student-2', firstName: 'Mariam', parentPhone: '2250700000003', parentEmail: null },
    ]);
    repository.upsertStudentAbsences.mockResolvedValue(2);

    let callCount = 0;
    eventEmitter.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('Redis down');
    });

    const result = await buildService().bulkMarkAbsences(
      { scheduleId: 'schedule-1', date: '2026-04-13', absences: ['student-1', 'student-2'] },
      context
    );

    // Premier event échoue, deuxième réussit
    expect(result.emittedEvents).toBe(1);
    expect(eventEmitter).toHaveBeenCalledTimes(2);
  });
});

// ─── listTodayAbsences ────────────────────────────────────────────────────────

describe('listTodayAbsences()', () => {
  it('regroupe correctement plusieurs absences de la même classe', async () => {
    repository.listTodayAbsences.mockResolvedValue([
      {
        classId: 'class-1', className: '3eme A',
        studentId: 'student-1', studentFirstName: 'Awa', studentLastName: 'Kouassi',
        scheduleId: 'sched-1', date: '2026-04-13', createdAt: new Date('2026-04-13T08:00:00Z'),
        smsStatus: 'sent', smsNotified: true, status: 'absent',
      },
      {
        classId: 'class-1', className: '3eme A',
        studentId: 'student-2', studentFirstName: 'Yao', studentLastName: 'Bamba',
        scheduleId: 'sched-1', date: '2026-04-13', createdAt: new Date('2026-04-13T08:00:00Z'),
        smsStatus: null, smsNotified: false, status: 'excused',
      },
      {
        classId: 'class-2', className: '3eme B',
        studentId: 'student-3', studentFirstName: 'Mariam', studentLastName: 'Traore',
        scheduleId: 'sched-2', date: '2026-04-13', createdAt: new Date('2026-04-13T08:00:00Z'),
        smsStatus: 'queued', smsNotified: false, status: 'absent',
      },
    ]);

    const result = await buildService().listTodayAbsences('2026-04-13');

    expect(result).toHaveLength(2);
    const classeA = result.find((g) => g.classId === 'class-1');
    expect(classeA?.absences).toHaveLength(2);
    expect(classeA?.absences.find((a) => a.studentId === 'student-2')?.status).toBe('excused');
    const classeB = result.find((g) => g.classId === 'class-2');
    expect(classeB?.absences).toHaveLength(1);
  });
});

// ─── getAbsenceStats ──────────────────────────────────────────────────────────

describe('getAbsenceStats()', () => {
  it('délègue au repository et retourne les données', async () => {
    const stats = [{ studentId: 'student-1', absenceCount: 5, excusedCount: 1 }];
    repository.getStudentAbsenceStats.mockResolvedValue(stats);

    const result = await buildService().getAbsenceStats({
      from: '2026-04-01',
      to: '2026-04-30',
      min_absences: 1,
    } as never);

    expect(result).toBe(stats);
    expect(repository.getStudentAbsenceStats).toHaveBeenCalledTimes(1);
  });
});

// ─── getStudentAbsences ───────────────────────────────────────────────────────

describe('getStudentAbsences()', () => {
  it('délègue au repository avec le bon studentId', async () => {
    const details = [{ id: 'att-1', date: '2026-04-13', status: 'absent' }];
    repository.getStudentAbsenceDetails.mockResolvedValue(details);

    const result = await buildService().getStudentAbsences('student-1', {
      from: '2026-04-01',
      to: '2026-04-30',
    });

    expect(result).toBe(details);
    expect(repository.getStudentAbsenceDetails).toHaveBeenCalledWith('student-1', {
      from: '2026-04-01',
      to: '2026-04-30',
    });
  });
});

describe('parent accounts provisioning', () => {
  it('dédoublonne par téléphone et lie le parent existant sans générer de mot de passe', async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'parent-1',
              full_name: 'Parent Existant',
              phone: '2250700000001',
              access_sent_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const createCredentials = vi.fn();

    const result = await ensureParentAccountForStudent(
      db,
      {
        studentId: 'student-2',
        fullName: 'Nom du formulaire',
        phone: '2250700000001',
        email: 'parent@test.ci',
      },
      createCredentials
    );

    expect(result).toMatchObject({ parentId: 'parent-1', created: false });
    expect(createCredentials).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it('renouvelle le mot de passe d’un compte existant sans aucun lien (nouveau parent principal)', async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: 'parent-1', full_name: 'Orphelin', phone: '2250700000001', access_sent_at: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const createCredentials = vi.fn().mockResolvedValue({ plainPassword: 'TEMP234567', passwordHash: 'hash' });

    const result = await ensureParentAccountForStudent(
      db,
      { studentId: 'student-2', fullName: 'Orphelin', phone: '2250700000001' },
      createCredentials
    );

    expect(createCredentials).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ parentId: 'parent-1', created: true, temporaryPassword: 'TEMP234567' });
  });

  it('crée un parent avec mot de passe temporaire puis le lie à l’élève', async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'parent-new',
              full_name: 'Parent Nouveau',
              phone: '2250700000002',
              access_sent_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const createCredentials = vi.fn().mockResolvedValue({
      plainPassword: 'ABCD234567',
      passwordHash: 'hash-parent',
    });

    const result = await ensureParentAccountForStudent(
      db,
      {
        studentId: 'student-1',
        fullName: 'Parent Nouveau',
        phone: '2250700000002',
      },
      createCredentials
    );

    expect(result).toEqual({
      parentId: 'parent-new',
      fullName: 'Parent Nouveau',
      phone: '2250700000002',
      created: true,
      temporaryPassword: 'ABCD234567',
    });
    expect(createCredentials).toHaveBeenCalledOnce();
  });

  it('génère et hashe indépendamment le mot de passe temporaire', async () => {
    const passwordGenerator = vi.fn().mockReturnValue('SAFE234567');
    const passwordHasher = vi.fn().mockResolvedValue('argon-hash');

    const result = await createTemporaryParentCredentials({
      passwordGenerator,
      passwordHasher,
    });

    expect(passwordGenerator).toHaveBeenCalledWith(10);
    expect(passwordHasher).toHaveBeenCalledWith('SAFE234567');
    expect(result).toEqual({ plainPassword: 'SAFE234567', passwordHash: 'argon-hash' });
  });
});

describe('parent access delivery', () => {
  it('construit un SMS avec lien, téléphone, mot de passe et changement obligatoire', () => {
    const message = buildParentAccessSms({
      loginUrl: 'https://app.ivoiredu.ci/parent/login',
      phone: '2250700000001',
      temporaryPassword: 'ABCD234567',
    });

    expect(message).toContain('https://app.ivoiredu.ci/parent/login');
    expect(message).toContain('2250700000001');
    expect(message).toContain('ABCD234567');
    expect(message).toContain('modifier');
  });

  it('met en file uniquement les parents dont les accès ne sont pas encore envoyés', async () => {
    const parentAccountsRepository = {
      listByIds: vi.fn().mockResolvedValue([
        {
          id: '11111111-1111-4111-8111-111111111111',
          fullName: 'Parent Pending',
          phone: '2250700000001',
          email: null,
          accessSentAt: null,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          fullName: 'Parent Sent',
          phone: '2250700000002',
          email: null,
          accessSentAt: '2026-08-18T10:00:00.000Z',
        },
      ]),
      updateTemporaryPassword: vi.fn(),
      getTenantSubdomain: vi.fn().mockResolvedValue('sainte-marie'),
      recordRotation: vi.fn(),
      transaction: vi.fn(async (callback: (repository: unknown) => Promise<unknown>) => callback(parentAccountsRepository)),
      insertAccessNotification: vi.fn(),
    };
    const smsQueue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
    const service = new ParentAccountsService(
      parentAccountsRepository as unknown as ParentAccountsRepository,
      {
        smsQueue,
        appBaseUrl: 'https://app.ivoiredu.ci/',
        passwordGenerator: () => 'ABCD234567',
        passwordHasher: async () => 'argon-hash',
      }
    );

    const result = await service.sendPendingAccess({
      schemaName: 'school_test',
      parentIds: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
      ],
    });

    expect(result.queued).toBe(1);
    expect(result.items).toEqual([
      { parentId: '11111111-1111-4111-8111-111111111111', status: 'queued' },
      { parentId: '22222222-2222-4222-8222-222222222222', status: 'already_sent' },
      { parentId: '33333333-3333-4333-8333-333333333333', status: 'not_found' },
    ]);
    expect(parentAccountsRepository.updateTemporaryPassword).toHaveBeenCalledOnce();
    expect(smsQueue.add).toHaveBeenCalledOnce();
  });
});
