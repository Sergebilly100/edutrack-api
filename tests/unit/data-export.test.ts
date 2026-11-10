import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  exportAllowed: true,
  role: 'director',
  students: { exportStudents: vi.fn(async () => ({ buffer: Buffer.from('xlsx'), fileName: 'eleves-2025-2026-2026-11-08.xlsx' })) },
  teachers: { exportTeachers: vi.fn(async () => ({ buffer: Buffer.from('xlsx'), fileName: 'professeurs-2025-2026-2026-11-08.xlsx' })) },
}));

vi.mock('../../src/shared/middleware/auth.middleware.js', () => {
  const attach = (request: { headers: Record<string, unknown>; claims?: unknown; auth?: unknown; permissions?: Set<string> }) => {
    request.claims = { schemaName: 'tenant_x', role: state.role, sub: 'u1' };
    request.auth = request.claims;
    request.permissions = new Set(String(request.headers['x-perms'] ?? '').split(',').filter(Boolean));
  };
  return {
    authenticateRequest: async (request: never) => attach(request),
    requireParent: async () => undefined,
    checkStudentAccess: async () => undefined,
    ParentAccessError: class extends Error {},
    requireAnyPermission: () => async (request: never) => attach(request),
    requirePermission: (permission: string) => async (request: { headers: Record<string, unknown> } & never, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      attach(request);
      if (!(request as { permissions: Set<string> }).permissions.has(permission)) reply.code(403).send({ error: 'forbidden' });
    },
  };
});
vi.mock('../../src/shared/database/db.js', () => ({
  db: { execute: async () => [{ allowed: state.exportAllowed }] },
  withTenantSchema: async (_schema: string, run: (db: unknown) => unknown) => run({}),
}));
vi.mock('../../src/modules/students/students.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildStudentsService: () => state.students,
}));
vi.mock('../../src/modules/teachers/teachers.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildTeachersService: () => state.teachers,
}));

import studentsController from '../../src/modules/students/students.controller.js';
import teachersController from '../../src/modules/teachers/teachers.controller.js';
import { buildExportWorkbook, exportFileName, sanitizeCell } from '../../src/shared/export/xlsx-safe.js';
import { StudentsService } from '../../src/modules/students/students.service.js';
import { TeachersService } from '../../src/modules/teachers/teachers.service.js';

const readSheet = async (buffer: Buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0]!;
  const rows: string[][] = [];
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? ''))));
  return { name: sheet.name, rows };
};

describe('xlsx-safe', () => {
  it('neutralise les débuts de formule mais laisse les téléphones intacts', () => {
    expect(sanitizeCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(sanitizeCell('+cmd|calc')).toBe("'+cmd|calc");
    expect(sanitizeCell('-2+3')).toBe("'-2+3");
    expect(sanitizeCell('@HYPERLINK("x")')).toBe(`'@HYPERLINK("x")`);
    expect(sanitizeCell('\t=1+1')).toBe("'=1+1");
    expect(sanitizeCell('+225 07 00 00 00 00')).toBe('+225 07 00 00 00 00');
    expect(sanitizeCell('0700000000')).toBe('0700000000');
    expect(sanitizeCell(null)).toBe('');
    expect(sanitizeCell('  Koné   Awa ')).toBe('Koné Awa');
  });

  it('écrit les accents et protège les formules dans le fichier', async () => {
    const buffer = await buildExportWorkbook({
      name: 'Test',
      columns: [{ header: 'Nom', key: 'name', width: 20 }, { header: 'Téléphone', key: 'phone', width: 20 }],
      rows: [{ name: '=1+1', phone: '+2250700000000' }, { name: 'Élodie Kouamé', phone: '0102030405' }],
    });
    const { rows } = await readSheet(buffer);
    expect(rows[0]).toEqual(['Nom', 'Téléphone']);
    expect(rows[1]).toEqual(["'=1+1", '+2250700000000']);
    expect(rows[2]).toEqual(['Élodie Kouamé', '0102030405']);
  });

  it('construit un nom de fichier explicite et sûr', () => {
    expect(exportFileName('eleves', '2025-2026', new Date('2026-11-08T10:00:00Z'))).toBe('eleves-2025-2026-2026-11-08.xlsx');
    expect(exportFileName('professeurs', 'Année « Spéciale »', new Date('2026-11-08T10:00:00Z'))).toBe('professeurs-annee-speciale-2026-11-08.xlsx');
  });
});

describe('StudentsService.exportStudents', () => {
  const baseRow = {
    matricule: '25-001', last_name: 'koné', first_name: 'AWA marie', sex: 'F', birth_date: '2012-03-05',
    birth_place: 'Abidjan', nationality: 'CI', level_name: '6ème', class_name: '6ème A', enrollment_status: 'confirmed',
    is_repeating: false, parent_name: 'Mme Koné', parent_phone: '+2250700000000', parent_email: 'p@example.com',
    parent_name_2: '=HYPERLINK("http://x")', parent_phone_2: null,
  };
  const build = (overrides: Partial<Record<string, unknown>> = {}) => {
    const repository = {
      findExportSchoolYear: vi.fn(async () => ('year' in overrides ? overrides.year : { id: 'y1', label: '2025-2026' })),
      listStudentsForExport: vi.fn(async () => [baseRow, { ...baseRow, matricule: null, is_repeating: null, enrollment_status: 'pending_cashier' }]),
    };
    return { repository, service: new StudentsService(repository as never) };
  };

  it('exporte les colonnes validées avec noms formatés, sans donnée financière', async () => {
    const { service, repository } = build();
    const file = await service.exportStudents({ class_id: 'c1', enrollment_status: 'confirmed' } as never);
    expect(repository.listStudentsForExport).toHaveBeenCalledWith({ class_id: 'c1', enrollment_status: 'confirmed' }, 'y1');
    expect(file.fileName).toMatch(/^eleves-2025-2026-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const { name, rows } = await readSheet(file.buffer);
    expect(name).toBe('Élèves');
    expect(rows[0]).toEqual(['Matricule', 'Nom', 'Prénoms', 'Sexe', 'Date de naissance', 'Lieu de naissance', 'Nationalité', 'Niveau', 'Classe',
      'Statut d’inscription', 'Redoublant', 'Parent 1 : nom', 'Parent 1 : téléphone', 'Parent 1 : e-mail', 'Parent 2 : nom', 'Parent 2 : téléphone']);
    expect(rows[0]!.join(' ')).not.toMatch(/solde|paiement|montant|salaire|tarif/i);
    expect(rows[1]!.slice(0, 11)).toEqual(['25-001', 'KONÉ', 'Awa Marie', 'F', '05/03/2012', 'Abidjan', "Côte d'Ivoire", '6ème', '6ème A', 'Inscrit', 'Non']);
    expect(rows[1]![12]).toBe('+2250700000000');
    expect(rows[1]![14]).toBe(`'=HYPERLINK("http://x")`);
    expect(rows[2]!.slice(9, 11)).toEqual(['En attente de caisse', '']);
  });

  it('refuse une année scolaire inconnue', async () => {
    const { service } = build({ year: null });
    await expect(service.exportStudents({ school_year_id: 'x' } as never)).rejects.toMatchObject({ code: 'SCHOOL_YEAR_NOT_FOUND', statusCode: 404 });
  });
});

describe('TeachersService.exportTeachers', () => {
  const row = {
    matricule: 'P-01', name: 'Koffi N’Guessan', sex: 'M', birth_date: '1980-01-31', birth_place: 'Bouaké', nationality: 'CI',
    type: 'vacataire', subjects: ['Maths', 'Physique'], class_names: ['6ème A', '5ème B'], phone: '+2250101010101',
    email: 'k@example.com', is_active: true, is_blocked: true,
  };

  it('exporte les colonnes validées, sans salaire ni taux horaire', async () => {
    const repository = {
      findExportSchoolYear: vi.fn(async () => ({ id: 'y1', label: '2025-2026' })),
      listTeachersForExport: vi.fn(async () => [row]),
    };
    const service = new TeachersService(repository as never);
    const file = await service.exportTeachers({ type: 'vacataire', school_year_id: 'y1' } as never);
    expect(repository.listTeachersForExport).toHaveBeenCalledWith({ type: 'vacataire' }, 'y1');
    expect(file.fileName).toMatch(/^professeurs-2025-2026-/);
    const { name, rows } = await readSheet(file.buffer);
    expect(name).toBe('Professeurs');
    expect(rows[0]).toEqual(['Matricule', 'Nom complet', 'Sexe', 'Date de naissance', 'Lieu de naissance', 'Nationalité', 'Type', 'Matières', 'Classes', 'Téléphone', 'E-mail', 'Statut']);
    expect(rows[0]!.join(' ')).not.toMatch(/salaire|taux|horaire|rémunération/i);
    expect(rows[1]).toEqual(['P-01', 'Koffi N’Guessan', 'M', '31/01/1980', 'Bouaké', "Côte d'Ivoire", 'Vacataire', 'Maths, Physique', '6ème A, 5ème B', '+2250101010101', 'k@example.com', 'Bloqué']);
  });

  it('refuse une année scolaire inconnue', async () => {
    const service = new TeachersService({ findExportSchoolYear: vi.fn(async () => null) } as never);
    await expect(service.exportTeachers({ school_year_id: 'x' } as never)).rejects.toMatchObject({ code: 'SCHOOL_YEAR_NOT_FOUND', statusCode: 404 });
  });
});

describe('routes d’export – permissions et réglage de l’école', () => {
  const build = async () => {
    const app = Fastify();
    await app.register(studentsController);
    await app.register(teachersController);
    return app;
  };
  const get = (app: Awaited<ReturnType<typeof build>>, url: string, perms: string) => app.inject({ method: 'GET', url, headers: { 'x-perms': perms } });

  beforeEach(() => { state.exportAllowed = true; state.role = 'director'; vi.clearAllMocks(); });

  it('exige students.view / teachers.view', async () => {
    const app = await build();
    expect((await get(app, '/api/v1/students/export', '')).statusCode).toBe(403);
    expect((await get(app, '/api/v1/teachers/export', '')).statusCode).toBe(403);
    expect(state.students.exportStudents).not.toHaveBeenCalled();
    expect(state.teachers.exportTeachers).not.toHaveBeenCalled();
  });

  it('refuse l’export des élèves à un professeur', async () => {
    state.role = 'teacher';
    const app = await build();
    expect((await get(app, '/api/v1/students/export', 'students.view')).statusCode).toBe(403);
    expect(state.students.exportStudents).not.toHaveBeenCalled();
  });

  it('refuse l’export quand le réglage de l’école le désactive', async () => {
    state.exportAllowed = false;
    const app = await build();
    for (const url of ['/api/v1/students/export', '/api/v1/teachers/export']) {
      const response = await get(app, url, 'students.view,teachers.view');
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'EXPORT_DISABLED' });
    }
    expect(state.students.exportStudents).not.toHaveBeenCalled();
    expect(state.teachers.exportTeachers).not.toHaveBeenCalled();
  });

  it('transmet l’année et les filtres, et renvoie un .xlsx nommé', async () => {
    const app = await build();
    const year = '11111111-1111-4111-8111-111111111111';
    const klass = '22222222-2222-4222-8222-222222222222';
    const students = await get(app, `/api/v1/students/export?school_year_id=${year}&class_id=${klass}&is_active=true&search=kon&enrollment_status=confirmed`, 'students.view');
    expect(students.statusCode).toBe(200);
    expect(students.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(students.headers['content-disposition']).toContain('eleves-2025-2026-2026-11-08.xlsx');
    expect(state.students.exportStudents).toHaveBeenCalledWith(expect.objectContaining({
      school_year_id: year, class_id: klass, is_active: true, search: 'kon', enrollment_status: 'confirmed',
    }));
    const teachers = await get(app, `/api/v1/teachers/export?school_year_id=${year}&type=permanent&subject=Maths`, 'teachers.view');
    expect(teachers.statusCode).toBe(200);
    expect(state.teachers.exportTeachers).toHaveBeenCalledWith(expect.objectContaining({ school_year_id: year, type: 'permanent', subject: 'Maths' }));
  });

  it('rejette un filtre invalide', async () => {
    const app = await build();
    expect((await get(app, '/api/v1/students/export?school_year_id=pas-un-uuid', 'students.view')).statusCode).toBe(400);
  });
});
