import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getAuthHeaders, getSeedContext, queryPublic, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

type Id = { id: string };
const xlsx = async (headers: string[], rows: Array<Array<string | number>>) => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Données');
  sheet.addRow(headers); rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
};
describe('C10 profiles, enrollments, assignments and first timetable', () => {
  let director: Record<string, string>; let admin: Record<string, string>;
  let teacherId: string; let userId: string; let yearId: string; let tenantId: string;
  const classes: string[] = []; const subjects: string[] = [];
  const levels: string[] = [];
  const profileHeaders = ['Matricule', 'Nom*', 'Prénom*', 'Type*', 'Email', 'Taux horaire FCFA'];
  const assignmentHeaders = ['Matricule', 'Matière', 'Classes'];
  const base = () => `/api/v1/admin/schools/${tenantId}/midyear-import/teacher_assignments`;
  const preview = (file: Buffer) => request().post(`${base()}/preview`).set(admin).query({ school_year_id: yearId }).attach('file', file, 'profs.xlsx');
  const confirm = (file: Buffer, previewToken: string) => request().post(`${base()}/confirm`).set(admin).query({ school_year_id: yearId, preview_token: previewToken }).attach('file', file, 'profs.xlsx');
  const pairs = () => [{ subject_id: subjects[0], class_id: classes[0] }, { subject_id: subjects[1], class_id: classes[1] }, { subject_id: subjects[2], class_id: classes[2] }];
  beforeAll(async () => {
    director = await getAuthHeaders('director');
    tenantId = (await queryPublic<Id>(`INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed) VALUES ('C10', $1, $2, 'pro', 'active', 100, true) RETURNING id::text`, [TEST_SCHEMA_NAME.replaceAll('_', '-'), TEST_SCHEMA_NAME]))[0].id;
    admin = { authorization: `Bearer ${await signAccessToken({ sub: getSeedContext().superAdminUserId, role: 'super_admin', schemaName: TEST_SCHEMA_NAME, tenantId })}` };
    await queryTenant("UPDATE school_years SET status='closed' WHERE status='active'");
    await queryTenant("INSERT INTO school_years (label,start_date,end_date,status) VALUES ('C10 historique','2025-09-01','2026-06-30','closed')");
    yearId = (await queryTenant<Id>("INSERT INTO school_years (label,start_date,end_date,status) VALUES ('C10','2026-09-01','2027-06-30','active') RETURNING id::text"))[0].id;
    for (const [index, name] of ['4e C10', '2nde C10', '3e C10'].entries()) {
      const levelId = (await queryTenant<Id>('INSERT INTO levels (name,order_index) VALUES ($1,$2) RETURNING id::text', [name, index]))[0].id;
      levels.push(levelId);
      subjects.push((await queryTenant<Id>('INSERT INTO subjects (level_id,name,coefficient) VALUES ($1,$2,1) RETURNING id::text', [levelId, index < 2 ? 'Mathématiques' : 'Chimie']))[0].id);
    }
    const response = await request().put(`${base()}/profile`).set(admin).send({ fields: assignmentHeaders.map((sourceColumnLabel, index) => ({ sourceColumnLabel, targetField: ['matricule','matiere','classes'][index], translations: [] })) });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });
  it('imports the initial profile and contract before any class exists', async () => {
    const file = await xlsx(profileHeaders, [['P-001', 'C10', 'Aya', 'vacataire', 'aya.c10@example.ci', 5000]]);
    const checked = await request().post('/api/v1/import/teachers/dry-run').set(director).attach('file', file, 'profs.xlsx');
    expect(checked.body).toMatchObject({ valid: 1, errors: [] });
    const response = await request().post('/api/v1/import/teachers/confirm').set(director).attach('file', file, 'profs.xlsx');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [teacher] = await queryTenant<{ id: string; user_id: string; subjects: string[] }>("SELECT id::text,user_id::text,subjects FROM teachers WHERE matricule='P-001'");
    teacherId = teacher.id; userId = teacher.user_id;
    expect(teacher.subjects).toEqual([]);
    expect(await queryTenant('SELECT id FROM teacher_subject_assignments WHERE teacher_id=$1', [teacherId])).toEqual([]);
    expect(await queryTenant('SELECT id FROM classes WHERE school_year_id=$1', [yearId])).toEqual([]);
  });
  it('creates classes through the C8 enrollment flow and assigns only three explicit pairs', async () => {
    const source = ['Matricule','Nom','Prénom','Niveau','Classe'];
    const root = `/api/v1/admin/schools/${tenantId}/midyear-import/students`;
    const mapping = await request().put(`${root}/profile`).set(admin).send({ fields: source.map((sourceColumnLabel,index) => ({ sourceColumnLabel, targetField: ['matricule','nom','prenom','niveau','classe'][index], translations: [] })) });
    expect(mapping.status).toBe(200);
    const file = await xlsx(source, [['E-1','Koné','Aya','4e C10','4e A'],['E-2','Koné','Ali','2nde C10','2nde C'],['E-3','Koné','Awa','3e C10','3e B']]);
    const checked = await request().post(`${root}/preview`).set(admin).query({ school_year_id: yearId }).attach('file',file,'eleves.xlsx');
    expect(checked.body.impact.classesCreated).toBe(3);
    const written = await request().post(`${root}/confirm`).set(admin).query({ school_year_id: yearId, preview_token: checked.body.previewToken }).attach('file',file,'eleves.xlsx');
    expect(written.status,JSON.stringify(written.body)).toBe(200);
    for (const name of ['4e A','2nde C','3e B']) classes.push((await queryTenant<Id>('SELECT id::text FROM classes WHERE name=$1 AND school_year_id=$2',[name,yearId]))[0].id);
    const response = await request().put(`/api/v1/teachers/${teacherId}`).set(director).send({ subjects: ['Mathématiques','Chimie'], teaching_assignments: pairs() });
    expect(response.status,JSON.stringify(response.body)).toBe(200);
    expect(response.body.teaching_assignments).toHaveLength(3);
    expect(response.body.classes_without_homeroom_teacher).toHaveLength(3);
    expect(await queryTenant('SELECT id FROM enrollments WHERE school_year_id=$1 AND status=\'confirmed\'',[yearId])).toHaveLength(3);
  });
  it('preserves pedagogical data on profile reimport, including obsolete columns', async () => {
    const file = await xlsx([...profileHeaders,'Matières*','Classes'],[['P-001','C10','Aya','vacataire','aya.c10@example.ci',6000,'Inventée','Inventée']]);
    const checked = await request().post('/api/v1/import/teachers/dry-run').set(director).attach('file',file,'profs.xlsx');
    expect(checked.body.preview[0]).not.toHaveProperty('Matières*');
    const response = await request().post('/api/v1/import/teachers/confirm').set(director).attach('file',file,'profs.xlsx');
    expect(response.status).toBe(200);
    expect((await queryTenant<{ subjects: string[]; hourly_rate: number }>('SELECT subjects,hourly_rate FROM teachers WHERE id=$1',[teacherId]))[0]).toMatchObject({ subjects: expect.arrayContaining(['Chimie']), hourly_rate: 6000 });
    expect(await queryTenant('SELECT id FROM teacher_subject_assignments WHERE teacher_id=$1',[teacherId])).toHaveLength(3);
  });
  it('rejects duplicate, wrong-level, closed-year, blocked and inactive individual assignments', async () => {
    const pair = pairs()[0];
    expect((await request().put(`/api/v1/teachers/${teacherId}`).set(director).send({ teaching_assignments: [pair,pair] })).body.code).toBe('DUPLICATE_TEACHING_ASSIGNMENT');
    expect((await request().put(`/api/v1/teachers/${teacherId}`).set(director).send({ teaching_assignments: [{ ...pair, class_id: classes[2] }] })).body.code).toBe('INVALID_TEACHING_ASSIGNMENT');
    const closed = (await queryTenant<Id>("INSERT INTO classes (name,level_id,school_year_id) SELECT 'Classe fermée', $1, id FROM school_years WHERE status='closed' LIMIT 1 RETURNING classes.id::text", [levels[0]]))[0].id;
    expect((await request().put(`/api/v1/teachers/${teacherId}`).set(director).send({ teaching_assignments: [{ ...pair, class_id: closed }] })).body.code).toBe('INVALID_TEACHING_ASSIGNMENT');
    for (const state of ['blocked','inactive']) {
      await queryTenant('UPDATE teachers SET is_blocked=$1 WHERE id=$2',[state==='blocked',teacherId]);
      await queryTenant('UPDATE users SET is_active=$1 WHERE id=$2',[state!=='inactive',userId]);
      expect((await request().put(`/api/v1/teachers/${teacherId}`).set(director).send({ teaching_assignments: pairs() })).body.code).toBe('TEACHER_UNAVAILABLE');
    }
    await queryTenant('UPDATE teachers SET is_blocked=false WHERE id=$1',[teacherId]);
    await queryTenant('UPDATE users SET is_active=true WHERE id=$1',[userId]);
  });
  it('imports admin groups, preserves historical assignments and refuses replay as existing pairs', async () => {
    const oldYear = (await queryTenant<Id>("SELECT id::text FROM school_years WHERE status='closed' LIMIT 1"))[0].id;
    const oldClass = (await queryTenant<Id>("INSERT INTO classes (name,level_id,school_year_id) VALUES ('Historique C10',$1,$2) RETURNING id::text",[levels[0],oldYear]))[0].id;
    await queryTenant('INSERT INTO teacher_subject_assignments (teacher_id,subject_id,class_id) VALUES ($1,$2,$3)',[teacherId,subjects[0],oldClass]);
    const removed = await request().put(`/api/v1/teachers/${teacherId}`).set(director).send({ teaching_assignments: [], subjects: [] });
    expect(removed.status).toBe(200);
    expect(await queryTenant('SELECT id FROM teacher_subject_assignments WHERE teacher_id=$1 AND class_id=$2',[teacherId,oldClass])).toHaveLength(1);
    const file = await xlsx(assignmentHeaders,[['P-001','Mathématiques','4e A, 2nde C'],['P-001','Chimie','3e B']]);
    const checked = await preview(file);
    expect(checked.body.impact.assignmentsCreated).toBe(3); expect(checked.body.errors).toEqual([]);
    const result = await confirm(file,checked.body.previewToken);
    expect(result.status,JSON.stringify(result.body)).toBe(200);
    expect(result.body.classesWithoutHomeroomTeacher).toHaveLength(3);
    expect(await queryTenant('SELECT id FROM teacher_subject_assignments WHERE teacher_id=$1',[teacherId])).toHaveLength(4);
    const again = await preview(file);
    expect(again.body.validRows).toEqual([]);
    expect(again.body.errors).toContainEqual(expect.objectContaining({ rowNumber: 2, column: 'Classes', value: '4e A', reason: expect.stringContaining('déjà existante') }));
  });
  it('reports every absent dependency without a partial group and denies director URL access', async () => {
    const file = await xlsx(assignmentHeaders,[['P-001','Mathématiques','4e A, inconnue'],['ABSENT','Chimie','3e B'],['P-001','Inconnue','3e B']]);
    const checked = await preview(file); expect(checked.body.validRows).toEqual([]);
    expect(checked.body.errors.some((e: { value: string }) => e.value==='inconnue')).toBe(true);
    expect((await confirm(file,checked.body.previewToken)).body.createdCount).toBe(0);
    for (const action of ['analyze','preview','confirm']) expect((await request().post(`${base()}/${action}`).set(director).query({ school_year_id: yearId }).attach('file',file,'profs.xlsx')).status).toBe(403);
    expect((await request().get(`${base()}/profile`).set(director)).status).toBe(403);
  });
  it('invalidates an admin preview when the teacher becomes blocked', async () => {
    const subject = (await queryTenant<Id>("INSERT INTO subjects (name,level_id,coefficient) VALUES ('Français',$1,1) RETURNING id::text",[levels[0]]))[0].id;
    const file = await xlsx(assignmentHeaders,[['P-001','Français','4e A']]);
    const checked = await preview(file); expect(checked.body.errors).toEqual([]);
    await queryTenant('UPDATE teachers SET is_blocked=true WHERE id=$1',[teacherId]);
    expect((await confirm(file,checked.body.previewToken)).body.code).toBe('RECOVERY_PREVIEW_STALE');
    const blocked = await preview(file); expect(blocked.body.errors[0].reason).toMatch(/bloqué/);
    expect(await queryTenant('SELECT id FROM teacher_subject_assignments WHERE subject_id=$1',[subject])).toEqual([]);
    await queryTenant('UPDATE teachers SET is_blocked=false WHERE id=$1',[teacherId]);
  });
  it('rejects normalized matricule ambiguity and every duplicated group before any insert', async () => {
    const [otherUser] = await queryTenant<Id>("INSERT INTO users (role,name,password_hash) VALUES ('teacher','Autre C10','not-used') RETURNING id::text");
    await queryTenant("INSERT INTO teachers (user_id,username,matricule,type,hourly_rate) VALUES ($1,'c10.ambigu','p-001','vacataire',5000)",[otherUser.id]);
    const file = await xlsx(assignmentHeaders,[['P-001','Français','4e A']]);
    try {
      const checked = await preview(file);
      expect(checked.body.validRows).toEqual([]);
      expect(checked.body.errors[0]).toMatchObject({ column: 'Matricule', reason: 'Matricule ambigu : P-001' });
      expect((await confirm(file,checked.body.previewToken)).body.createdCount).toBe(0);
    } finally {
      await queryTenant('DELETE FROM teachers WHERE user_id=$1',[otherUser.id]);
      await queryTenant('DELETE FROM users WHERE id=$1',[otherUser.id]);
    }
    const duplicated = await preview(await xlsx(assignmentHeaders,[['P-001','Français','4e A'],['P-001','Français','4E   A']]));
    expect(duplicated.body.validRows).toEqual([]);
    expect(duplicated.body.errors.map((e: { rowNumber: number }) => e.rowNumber)).toEqual([2,3]);
  });
  it('rolls back every pair when a late write fails', async () => {
    await queryTenant("INSERT INTO subjects (name,level_id,coefficient) VALUES ('Français',$1,1)",[levels[1]]);
    const file = await xlsx(assignmentHeaders,[['P-001','Français','4e A, 2nde C']]);
    const checked = await preview(file); expect(checked.body.errors).toEqual([]);
    await queryTenant(`CREATE FUNCTION c10_reject_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.class_id = '${classes[1]}'::uuid THEN RAISE EXCEPTION 'Rejected test write'; END IF; RETURN NEW; END; $$`);
    await queryTenant('CREATE TRIGGER c10_assignment_failure BEFORE INSERT ON teacher_subject_assignments FOR EACH ROW EXECUTE FUNCTION c10_reject_assignment()');
    try {
      const response = await confirm(file,checked.body.previewToken);
      expect(response.status).toBe(409); expect(response.body.code).toBe('RECOVERY_WRITE_FAILED');
      expect(await queryTenant("SELECT a.id FROM teacher_subject_assignments a JOIN subjects s ON s.id=a.subject_id WHERE a.teacher_id=$1 AND s.name='Français'",[teacherId])).toEqual([]);
    } finally {
      await queryTenant('DROP TRIGGER c10_assignment_failure ON teacher_subject_assignments');
      await queryTenant('DROP FUNCTION c10_reject_assignment()');
    }
  });
  it('imports the first timetable without creating assignments, and rejects unassigned/blocked/inactive teachers and duplication', async () => {
    const [teacher] = await queryTenant<{ name: string }>('SELECT name FROM users WHERE id=$1',[userId]);
    const [slot] = await queryTenant<{ label: string }>('SELECT label FROM time_slots ORDER BY sort_order LIMIT 1');
    const headers = ['Nom professeur*','Classe*','Matière*','Jour*','Créneau*','Salle'];
    const file = await xlsx(headers,[[teacher.name,'4e A','Mathématiques','Lundi',slot.label,'Salle A1']]);
    const send = (action: string, buffer=file) => request().post(`/api/v1/import/schedule/${action}`).set(director).field('week_start','2026-11-02').field('week_end','2026-11-08').attach('file',buffer,'edt.xlsx');
    const checked = await send('dry-run'); expect(checked.body.errors).toEqual([]);
    const result = await send('confirm'); expect(result.status,JSON.stringify(result.body)).toBe(200);
    expect(await queryTenant('SELECT id FROM teacher_subject_assignments WHERE teacher_id=$1',[teacherId])).toHaveLength(4);
    const wrong = await send('dry-run',await xlsx(headers,[[teacher.name,'3e B','Mathématiques','Lundi',slot.label,'Salle A1']]));
    expect(wrong.body.errors.some((e: { message: string }) => /affecté/.test(e.message))).toBe(true);
    const [schedule] = await queryTenant<{ schedule_period_id: string; room_id: string; time_slot_id: string }>('SELECT schedule_period_id::text,room_id::text,time_slot_id::text FROM schedules WHERE teacher_id=$1 LIMIT 1',[teacherId]);
    for (const state of ['blocked','inactive','unassigned']) {
      await queryTenant('UPDATE teachers SET is_blocked=$1 WHERE id=$2',[state==='blocked',teacherId]);
      await queryTenant('UPDATE users SET is_active=$1 WHERE id=$2',[state!=='inactive',userId]);
      if (state==='unassigned') await queryTenant('DELETE FROM teacher_subject_assignments WHERE teacher_id=$1 AND class_id=$2',[teacherId,classes[0]]);
      const manual = await request().post('/api/v1/schedule').set(director).send({ schedule_period_id: schedule.schedule_period_id, teacher_id: teacherId, class_id: classes[0], room_id: schedule.room_id, time_slot_id: schedule.time_slot_id, day_of_week: 2, subject: 'Mathématiques' });
      expect(manual.status).toBe(state==='blocked' ? 409 : 400);
      expect((await send('confirm')).status).toBe(400);
      const copy = await request().post(`/api/v1/schedule/periods/${schedule.schedule_period_id}/duplicate`).set(director).send({ new_name: `Copie ${state}`, new_valid_from: '2026-11-09', new_valid_to: '2026-11-15' });
      expect(copy.status,JSON.stringify(copy.body)).toBe(state==='blocked' ? 409 : 400);
      expect(await queryTenant('SELECT id FROM schedule_periods WHERE name=$1',[`Copie ${state}`])).toEqual([]);
    }
  });
});
