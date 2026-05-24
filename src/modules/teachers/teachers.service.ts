import type {
  CreateTeacherInput,
  TeacherAttendanceStatsQuery,
  TeachersListQuery,
  UpdateTeacherInput,
} from './teachers.types.js';
import { TeachersRepository } from './teachers.repository.js';
import { getMaxUsersBySchemaName } from '../../shared/utils/users-limit.js';
import { canonicalizeSubjectList } from '../../shared/utils/subject-normalization.js';
import { defaultEmailSender } from '../notifications/notifications.service.js';
import { logger } from '../../shared/observability/logger.js';

export class TeachersModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'TeachersModuleError';
  }
}

// DTO partagé pour toutes les réponses du module teachers.
// Expose les deux dimensions distinctes :
//   • is_active    → accès au compte (table users)
//   • is_blocked   → blocage métier avec motif (table teachers)
type TeacherDTO = {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  type: 'vacataire' | 'permanent';
  subjects: string[];
  hourly_rate: number | null;
  monthly_salary: number | null;
  is_active: boolean;
  is_blocked: boolean;
  blocked_reason: string | null;
  blocked_at: Date | null;
  username: string;
  updated_at: Date | null;
  updated_by: string | null;
  updated_by_name: string | null;
};

const toDTO = (row: {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  type: 'vacataire' | 'permanent';
  subjects: string[];
  hourly_rate: number | null;
  monthly_salary: number | null;
  is_active: boolean;
  is_blocked: boolean;
  blocked_reason: string | null;
  blocked_at: Date | null;
  username: string;
  updated_at?: Date | null;
  updated_by?: string | null;
  updated_by_name?: string | null;
}): TeacherDTO => ({
  id: row.id,
  name: row.name,
  first_name: row.first_name,
  last_name: row.last_name,
  phone: row.phone,
  email: row.email,
  type: row.type,
  subjects: row.subjects,
  hourly_rate: row.hourly_rate,
  monthly_salary: row.monthly_salary,
  is_active: row.is_active,
  is_blocked: row.is_blocked,
  blocked_reason: row.blocked_reason,
  blocked_at: row.blocked_at,
  username: row.username,
  updated_at: row.updated_at ?? null,
  updated_by: row.updated_by ?? null,
  updated_by_name: row.updated_by_name ?? null,
});

export class TeachersService {
  constructor(private readonly repository: TeachersRepository) {}

  async listTeachers(query: TeachersListQuery): Promise<{
    data: TeacherDTO[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const result = await this.repository.listTeachers(query);
    return {
      data: result.rows.map(toDTO),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / query.limit) || 1,
      },
    };
  }

  async getTeacherById(teacherId: string): Promise<TeacherDTO> {
    const row = await this.repository.getTeacherById(teacherId);
    if (!row) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }
    return toDTO(row);
  }

  async createTeacher(input: CreateTeacherInput, context: { schemaName: string }) {
    const [currentCount, maxUsers] = await Promise.all([
      this.repository.countActiveUsers(),
      getMaxUsersBySchemaName(context.schemaName),
    ]);

    if (currentCount >= maxUsers) {
      throw new TeachersModuleError(
        'Limite du plan atteinte',
        403,
        'PLAN_LIMIT_REACHED'
      );
    }

    const created = await this.repository.createTeacher({
      ...input,
      subjects: canonicalizeSubjectList(input.subjects),
    });
    return toDTO(created);
  }

  async updateTeacher(teacherId: string, input: UpdateTeacherInput, actorId?: string | null) {
    const current = await this.repository.getTeacherById(teacherId);
    if (!current) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    const nextType = input.type ?? current.type;
    const nextHourlyRate =
      input.hourly_rate !== undefined ? input.hourly_rate : current.hourly_rate;
    const nextMonthlySalary =
      input.monthly_salary !== undefined ? input.monthly_salary : current.monthly_salary;

    if (nextType === 'vacataire' && nextHourlyRate === null) {
      throw new TeachersModuleError(
        'Hourly rate is required for vacataire',
        400,
        'HOURLY_RATE_REQUIRED'
      );
    }

    if (nextType === 'permanent' && nextMonthlySalary === null) {
      throw new TeachersModuleError(
        'Monthly salary is required for permanent',
        400,
        'MONTHLY_SALARY_REQUIRED'
      );
    }

    if (input.type !== undefined && input.type !== current.type) {
      const hasOutstandingUnpaidSalaryRecords =
        await this.repository.hasOutstandingUnpaidSalaryRecords(teacherId);
      if (hasOutstandingUnpaidSalaryRecords) {
        throw new TeachersModuleError(
          'Teacher type change is blocked until all salary records are paid',
          409,
          'TEACHER_TYPE_CHANGE_BLOCKED'
        );
      }
    }

    // Politique : on conserve toujours hourly_rate et monthly_salary en base,
    // même si le type courant ne les utilise pas. Cela préserve la cohérence
    // historique : les salary_records antérieurs gardent leur référence au taux,
    // et un retour à l'ancien type ne demande pas de re-saisie. Le calcul de
    // salaire (recalculate*ForMonth) lit sr.hourly_rate snapshoté à la création
    // du record, pas t.hourly_rate, donc l'historique reste correct.
    const updated = await this.repository.updateTeacher(
      teacherId,
      {
        ...input,
        ...(input.subjects ? { subjects: canonicalizeSubjectList(input.subjects) } : {}),
        hourly_rate: nextHourlyRate,
        monthly_salary: nextMonthlySalary,
      },
      actorId ?? null
    );
    if (!updated) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }
    return toDTO(updated);
  }

  async softDeleteTeacher(teacherId: string) {
    const deleted = await this.repository.softDeleteTeacher(teacherId);
    if (!deleted) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }
    return toDTO(deleted);
  }

  async getTeacherStats(teacherId: string, dateFrom: string, dateTo: string) {
    const stats = await this.repository.getTeacherStats(teacherId, dateFrom, dateTo);
    if (!stats) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }
    return stats;
  }

  async getAttendanceStats(params: TeacherAttendanceStatsQuery) {
    return this.repository.getAttendanceStats(params);
  }

  /**
   * Réinitialise le mot de passe d'un prof : génère un mot de passe temporaire,
   * force must_change_password, marque credentials_sent_at.
   * Si email présent → tentative d'envoi par email (mot de passe non renvoyé dans la réponse).
   * Si pas d'email → renvoie le mot de passe en clair pour transmission manuelle.
   */
  async resetTeacherPassword(teacherId: string): Promise<{
    emailSent: boolean;
    email: string | null;
    plainPassword?: string;
  }> {
    const reset = await this.repository.resetTeacherPassword(teacherId);
    if (!reset) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    if (!reset.email) {
      return { emailSent: false, email: null, plainPassword: reset.plainPassword };
    }

    const subject = "Vos identifiants EduTrack";
    const text = buildCredentialsEmailText({
      fullName: reset.fullName,
      username: reset.username,
      plainPassword: reset.plainPassword,
    });

    try {
      const result = await defaultEmailSender({
        to: reset.email,
        subject,
        text,
        type: 'custom',
        schemaName: 'public',
      });
      if (result.status === 'sent') {
        return { emailSent: true, email: reset.email };
      }
      logger.warn({ teacherId, error: result.errorMessage }, '[teachers] credentials email failed');
      return { emailSent: false, email: reset.email, plainPassword: reset.plainPassword };
    } catch (error) {
      logger.error({ teacherId, err: error }, '[teachers] credentials email crashed');
      return { emailSent: false, email: reset.email, plainPassword: reset.plainPassword };
    }
  }

  /**
   * Envoie les credentials aux profs qui n'en ont pas encore reçus.
   * - teacherIds optionnel : restreint à un sous-ensemble.
   * - Pour chaque prof avec email : regénère mot de passe + envoie email.
   * - Pour chaque prof sans email : skip (signalé dans le résultat).
   */
  async sendCredentialsToTeachers(teacherIds?: string[]): Promise<{
    sentCount: number;
    skippedNoEmailCount: number;
    failedCount: number;
    skippedNoEmail: Array<{ teacherId: string; name: string }>;
  }> {
    const targets = await this.repository.listTeachersWithoutCredentials(teacherIds);

    let sentCount = 0;
    let failedCount = 0;
    const skippedNoEmail: Array<{ teacherId: string; name: string }> = [];

    for (const target of targets) {
      if (!target.email) {
        skippedNoEmail.push({ teacherId: target.teacher_id, name: target.name });
        continue;
      }

      const reset = await this.repository.resetTeacherPassword(target.teacher_id);
      if (!reset) {
        failedCount += 1;
        continue;
      }

      const subject = "Vos identifiants EduTrack";
      const text = buildCredentialsEmailText({
        fullName: reset.fullName,
        username: reset.username,
        plainPassword: reset.plainPassword,
      });

      try {
        const result = await defaultEmailSender({
          to: target.email,
          subject,
          text,
          type: 'custom',
          schemaName: 'public',
        });
        if (result.status === 'sent') {
          sentCount += 1;
        } else {
          failedCount += 1;
          logger.warn({ teacherId: target.teacher_id, error: result.errorMessage }, '[teachers] bulk credentials email failed');
        }
      } catch (error) {
        failedCount += 1;
        logger.error({ teacherId: target.teacher_id, err: error }, '[teachers] bulk credentials email crashed');
      }
    }

    return {
      sentCount,
      skippedNoEmailCount: skippedNoEmail.length,
      failedCount,
      skippedNoEmail,
    };
  }
}

const buildCredentialsEmailText = (params: {
  fullName: string;
  username: string;
  plainPassword: string;
}): string => {
  return [
    `Bonjour ${params.fullName},`,
    ``,
    `Voici vos identifiants de connexion EduTrack :`,
    `  • Identifiant : ${params.username}`,
    `  • Mot de passe temporaire : ${params.plainPassword}`,
    ``,
    `Pour des raisons de sécurité, vous devrez changer ce mot de passe lors de votre première connexion.`,
    ``,
    `À bientôt,`,
    `L'équipe EduTrack`,
  ].join('\n');
};

export const buildTeachersService = (
  db: ConstructorParameters<typeof TeachersRepository>[0]
): TeachersService => new TeachersService(new TeachersRepository(db));
