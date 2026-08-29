import {
  StudentDossierRepository,
  type DossierEvent,
  type StudentDossierProfile,
} from './student-dossier.repository.js';

export type DossierViewerRole = 'director' | 'staff' | 'teacher' | 'super_admin';

export class StudentDossierError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'StudentDossierError';
  }
}

export type StudentDossier = {
  student: StudentDossierProfile;
  events: DossierEvent[];
};

export class StudentDossierService {
  constructor(private readonly repository: StudentDossierRepository) {}

  async getDossier(input: {
    studentId: string;
    role: DossierViewerRole;
    userId: string;
    date: string;
  }): Promise<StudentDossier> {
    const student = await this.repository.findStudentProfile(input.studentId);
    if (!student) {
      throw new StudentDossierError('Student not found', 404, 'STUDENT_NOT_FOUND');
    }

    if (input.role === 'teacher') {
      const teacherId = await this.repository.findTeacherIdByUserId(input.userId);
      if (!teacherId || !(await this.repository.teacherCanAccessStudent(teacherId, input.studentId, input.date))) {
        throw new StudentDossierError('Forbidden', 403, 'FORBIDDEN');
      }
      return {
        student,
        events: await this.repository.listEvents(input.studentId, teacherId),
      };
    }

    return {
      student,
      events: await this.repository.listEvents(input.studentId, null),
    };
  }
}
