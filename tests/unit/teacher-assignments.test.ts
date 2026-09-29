import { describe, expect, it } from 'vitest';
import { splitAssignmentClasses, validateTeacherAssignmentRows, type AssignmentSnapshot } from '../../src/shared/import-mapping/teacher-assignments.js';

const snapshot = (): AssignmentSnapshot => ({
  teachers: [{ id: 'p1', matricule: 'P-001', isActive: true, isBlocked: false }],
  classes: [{ id: '4a', name: '4e A', levelId: '4', isActive: true }, { id: '2c', name: '2nde C', levelId: '2', isActive: true }, { id: '3b', name: '3e B', levelId: '3', isActive: true }],
  subjects: [{ id: 'math4', name: 'Mathématiques', levelId: '4' }, { id: 'math2', name: 'Mathématiques', levelId: '2' }, { id: 'chim3', name: 'Chimie', levelId: '3' }],
  assignments: [],
});
const row = (classes = '4e A, 2nde C', matiere = 'Mathématiques', rowNumber = 2) => ({ rowNumber, values: { matricule: 'P-001', matiere, classes } });

describe('C10 teacher assignment groups', () => {
  it('normalizes comma-separated classes without hiding empty or repeated values', () => {
    expect(splitAssignmentClasses(' 4e   A,\u00a02nde C , 4e A, ')).toEqual(['4e A', '2nde C', '4e A', '']);
  });
  it('creates only the requested subject–class pairs across levels', () => {
    const result = validateTeacherAssignmentRows([row(), row('3e B', 'Chimie', 3)], snapshot());
    expect(result.errors).toEqual([]);
    expect(result.validRows.flatMap((item) => item.teachingAssignments)).toEqual([
      { teacherId: 'p1', subjectId: 'math4', classId: '4a' },
      { teacherId: 'p1', subjectId: 'math2', classId: '2c' },
      { teacherId: 'p1', subjectId: 'chim3', classId: '3b' },
    ]);
  });
  it('matches a professor matricule regardless of case and surrounding spaces', () => {
    const input = row(); input.values.matricule = ' p-001 ';
    expect(validateTeacherAssignmentRows([input], snapshot()).validRows).toHaveLength(1);
    input.values.matricule = 'P- 001';
    expect(validateTeacherAssignmentRows([input], snapshot()).validRows).toHaveLength(0);
  });
  it('rejects every row containing a duplicate pair, including overlaps between groups', () => {
    const result = validateTeacherAssignmentRows([row(), row('4E   A', 'Maths', 3)], snapshot());
    expect(result.validRows).toEqual([]);
    expect(result.errors.map((issue) => issue.rowNumber)).toEqual([2, 3]);
    expect(validateTeacherAssignmentRows([row('4e A, 4E A')], snapshot()).validRows).toEqual([]);
  });
  it.each(['unknown-class', 'empty-class', 'unknown-teacher', 'ambiguous-teacher', 'blocked', 'inactive', 'inactive-class', 'unknown-subject', 'wrong-level', 'ambiguous-subject', 'existing-pair'])('rejects %s atomically with line and value diagnostics', (kind) => {
    const data = snapshot(); const input = row();
    if (kind === 'unknown-class') input.values.classes += ', absente';
    if (kind === 'empty-class') input.values.classes += ',';
    if (kind === 'unknown-teacher') input.values.matricule = 'absent';
    if (kind === 'ambiguous-teacher') data.teachers.push({ ...data.teachers[0], id: 'p2' });
    if (kind === 'blocked') data.teachers[0].isBlocked = true;
    if (kind === 'inactive') data.teachers[0].isActive = false;
    if (kind === 'inactive-class') data.classes[1].isActive = false;
    if (kind === 'unknown-subject') input.values.matiere = 'absente';
    if (kind === 'wrong-level') data.subjects = data.subjects.filter((s) => s.id !== 'math2');
    if (kind === 'ambiguous-subject') data.subjects.push({ ...data.subjects[0], id: 'other' });
    if (kind === 'existing-pair') data.assignments.push({ teacherId: 'p1', subjectId: 'math4', classId: '4a' });
    const result = validateTeacherAssignmentRows([input], data);
    expect(result.validRows).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    for (const issue of result.errors) expect(issue).toMatchObject({ rowNumber: 2, column: expect.any(String), value: expect.any(String), reason: expect.any(String) });
  });
});
