import { describe, expect, it } from 'vitest';
import { getAuthHeaders, queryPublic, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

describe('matricule uniqueness through HTTP', () => {
  it('rejects case and surrounding-space variants on student and teacher creates and updates', async () => {
    const headers = await getAuthHeaders('director');
    const suffix = Date.now().toString(36);
    const studentCode = `C20-E-${suffix}`;
    const firstStudent = await request().post('/api/v1/students').set(headers).send({ first_name: 'Aya', last_name: 'C20', matricule: studentCode });
    expect(firstStudent.status, JSON.stringify(firstStudent.body)).toBe(201);
    const studentId = firstStudent.body.data.id as string;
    const duplicateStudent = await request().post('/api/v1/students').set(headers).send({ first_name: 'Ali', last_name: 'C20', matricule: ` ${studentCode.toLowerCase()} ` });
    expect(duplicateStudent.body).toMatchObject({ statusCode: 409, code: 'MATRICULE_ALREADY_EXISTS' });
    const blankStudent = await request().post('/api/v1/students').set(headers).send({ first_name: 'Aminata', last_name: 'C20', matricule: null });
    expect(blankStudent.status, JSON.stringify(blankStudent.body)).toBe(201);
    const studentUpdate = await request().put(`/api/v1/students/${blankStudent.body.data.id}`).set(headers).send({ matricule: ` ${studentCode.toLowerCase()} ` });
    expect(studentUpdate.body).toMatchObject({ statusCode: 409, code: 'MATRICULE_ALREADY_EXISTS' });
    expect((await queryTenant<{ first_name: string; matricule: string }>('SELECT first_name, matricule FROM students WHERE id = $1', [studentId]))[0]).toEqual({ first_name: 'Aya', matricule: studentCode });

    await queryPublic(`INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users)
      VALUES ('C20 matricule', $1, $1, 'pro', 'active', 100)
      ON CONFLICT (schema_name) DO UPDATE SET max_users = 100`, [TEST_SCHEMA_NAME]);
    const teacherCode = `C20-P-${suffix}`;
    const teacherPayload = (firstName: string, matricule: string | null) => ({ first_name: firstName, last_name: 'C20', matricule, email: `${firstName.toLowerCase()}.${suffix}@example.test`, type: 'vacataire', hourly_rate: 5000, subjects: [] });
    const firstTeacher = await request().post('/api/v1/teachers').set(headers).send(teacherPayload('Aya', teacherCode));
    expect(firstTeacher.status, JSON.stringify(firstTeacher.body)).toBe(201);
    const duplicateTeacher = await request().post('/api/v1/teachers').set(headers).send(teacherPayload('Ali', ` ${teacherCode.toLowerCase()} `));
    expect(duplicateTeacher.body).toMatchObject({ statusCode: 409, code: 'MATRICULE_ALREADY_EXISTS' });
    const blankTeacher = await request().post('/api/v1/teachers').set(headers).send(teacherPayload('Aminata', null));
    expect(blankTeacher.status, JSON.stringify(blankTeacher.body)).toBe(201);
    const teacherUpdate = await request().put(`/api/v1/teachers/${blankTeacher.body.id}`).set(headers).send({ matricule: ` ${teacherCode.toLowerCase()} ` });
    expect(teacherUpdate.body).toMatchObject({ statusCode: 409, code: 'MATRICULE_ALREADY_EXISTS' });
    expect((await queryTenant<{ matricule: string }>('SELECT matricule FROM teachers WHERE id = $1', [firstTeacher.body.id]))[0]?.matricule).toBe(teacherCode);
  });
});
