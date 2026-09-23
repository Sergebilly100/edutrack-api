import { describe, expect, it, vi } from 'vitest';

import { ParentPortalError, ParentPortalService } from '../../src/modules/parent-portal/parent-portal.service.js';

describe('parent portal lifecycle access', () => {
  it.each(['expelled', 'transferred'])('bloque une session existante quand l’élève devient %s', async () => {
    const repository = {
      parentCanAccessStudent: vi.fn().mockResolvedValue(false),
      getStudentClassId: vi.fn(),
    };
    const service = new ParentPortalService(repository as never);
    await expect(service.getStudentSchedule(
      { studentId: 'student-id', week: '2026-W34' },
      { parentId: 'parent-id', allowedStudentIds: ['student-id'] }
    )).rejects.toMatchObject<Partial<ParentPortalError>>({ code: 'STUDENT_ACCESS_DENIED', statusCode: 403 });
    expect(repository.getStudentClassId).not.toHaveBeenCalled();
  });
});
