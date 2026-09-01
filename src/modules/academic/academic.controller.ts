import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requirePermission, requireTeacher } from '../../shared/middleware/auth.middleware.js';
import { AcademicGradingError, buildAcademicGradingService } from './academic-grading.service.js';
import {
  academicIdParamsSchema,
  completionBodySchema,
  completionQuerySchema,
  createEvaluationBodySchema,
  createGradingPeriodBodySchema,
  createSubjectBodySchema,
  createSubjectsBulkBodySchema,
  updateSubjectsBulkBodySchema,
  listGradingPeriodsQuerySchema,
  listSubjectsQuerySchema,
  updateGradingPeriodBodySchema,
  updateSubjectBodySchema,
  upsertEvaluationGradeBodySchema,
  evaluationsScopeQuerySchema,
  spontaneousGradeBodySchema,
} from './academic-grading.types.js';
import { AcademicModuleError, buildAcademicService } from './academic.service.js';
import {
  classIdParamsSchema,
  createClassBodySchema,
  createLevelBodySchema,
  listClassesQuerySchema,
  levelIdParamsSchema,
  schoolYearIdParamsSchema,
  updateClassBodySchema,
  updateLevelBodySchema,
  updateSchoolYearBodySchema,
} from './academic.types.js';

const handleError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown
): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Invalid request',
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: error.issues,
    });
  }

  if (error instanceof AcademicModuleError || error instanceof AcademicGradingError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  request.log.error({ err: error }, '[academic] Unexpected error');
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function academicController(app: FastifyInstance): Promise<void> {
  
  // recuperation de la liste des années scolaires
  app.get(
    '/api/v1/school-years',
    { preHandler: requirePermission('school_years.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildAcademicService(tenantDb).listSchoolYears()
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
  // modification d'une année scolaire
  app.patch(
    '/api/v1/school-years/:id',
    { preHandler: requirePermission('school_years.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = schoolYearIdParamsSchema.parse(request.params ?? {});
        const body = updateSchoolYearBodySchema.parse(request.body ?? {});
        const schoolYear = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildAcademicService(tenantDb).updateSchoolYear(params.id, body)
        );
        return reply.send({ schoolYear });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
  // recuperation de la liste des niveaux
  app.get(
    '/api/v1/levels',
    { preHandler: requirePermission('classes.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildAcademicService(tenantDb).listLevels()
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/levels',
    { preHandler: requirePermission('classes.create') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = createLevelBodySchema.parse(request.body ?? {});
        const level = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildAcademicService(tenantDb).createLevel(body)
        );
        return reply.code(201).send({ level });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/levels/:id',
    { preHandler: requirePermission('classes.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = levelIdParamsSchema.parse(request.params ?? {});
        const body = updateLevelBodySchema.parse(request.body ?? {});
        const level = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildAcademicService(tenantDb).updateLevel(params.id, body)
        );
        return reply.send({ level });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/levels/:id',
    { preHandler: requirePermission('classes.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = levelIdParamsSchema.parse(request.params ?? {});
        const level = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildAcademicService(tenantDb).deleteLevel(params.id)
        );
        return reply.send({ level });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/classes',
    { preHandler: requirePermission('classes.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = listClassesQuerySchema.parse(request.query ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildAcademicService(tenantDb).listClasses(query.schoolYearId)
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/classes',
    { preHandler: requirePermission('classes.create') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = createClassBodySchema.parse(request.body ?? {});
        const schoolClass = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildAcademicService(tenantDb).createClass(body)
        );
        return reply.code(201).send({ class: schoolClass });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/classes/:id',
    { preHandler: requirePermission('classes.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = classIdParamsSchema.parse(request.params ?? {});
        const body = updateClassBodySchema.parse(request.body ?? {});
        const schoolClass = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildAcademicService(tenantDb).updateClass(params.id, body)
        );
        return reply.send({ class: schoolClass });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/classes/:id',
    { preHandler: requirePermission('classes.delete') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = classIdParamsSchema.parse(request.params ?? {});
        const schoolClass = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildAcademicService(tenantDb).archiveClass(params.id)
        );
        return reply.send({ class: schoolClass });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/subjects',
    { preHandler: requirePermission('classes.view') },
    async (request, reply) => {
      try {
        const query = listSubjectsQuerySchema.parse(request.query ?? {});
        const result = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildAcademicGradingService(tenantDb).listSubjects(query.levelId)
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/subjects',
    { preHandler: requirePermission('classes.edit') },
    async (request, reply) => {
      try {
        const body = createSubjectBodySchema.parse(request.body ?? {});
        const subject = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          tenantDb.transaction((tx) => buildAcademicGradingService(tx).createSubject(body))
        );
        return reply.code(201).send({ subject });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/subjects/bulk',
    { preHandler: requirePermission('classes.edit') },
    async (request, reply) => {
      try {
        const body = createSubjectsBulkBodySchema.parse(request.body ?? {});
        const subjects = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          tenantDb.transaction((tx) => buildAcademicGradingService(tx).createSubjectsBulk(body))
        );
        return reply.code(201).send({ subjects });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/subjects/bulk',
    { preHandler: requirePermission('classes.edit') },
    async (request, reply) => {
      try {
        const body = updateSubjectsBulkBodySchema.parse(request.body ?? {});
        const subjects = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          tenantDb.transaction((tx) => buildAcademicGradingService(tx).updateSubjectsBulk(body))
        );
        return reply.send({ subjects });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/subjects/:id',
    { preHandler: requirePermission('classes.edit') },
    async (request, reply) => {
      try {
        const { id } = academicIdParamsSchema.parse(request.params ?? {});
        const body = updateSubjectBodySchema.parse(request.body ?? {});
        const subject = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          tenantDb.transaction((tx) => buildAcademicGradingService(tx).updateSubject(id, body))
        );
        return reply.send({ subject });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/subjects/:id',
    { preHandler: requirePermission('classes.edit') },
    async (request, reply) => {
      try {
        const { id } = academicIdParamsSchema.parse(request.params ?? {});
        await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildAcademicGradingService(tenantDb).deleteSubject(id)
        );
        return reply.code(204).send();
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/grading-periods',
    { preHandler: requirePermission('school_years.view') },
    async (request, reply) => {
      try {
        const query = listGradingPeriodsQuerySchema.parse(request.query ?? {});
        const result = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildAcademicGradingService(tenantDb).listGradingPeriods(query.schoolYearId)
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/grading-periods',
    { preHandler: requirePermission('school_years.edit') },
    async (request, reply) => {
      try {
        const body = createGradingPeriodBodySchema.parse(request.body ?? {});
        const gradingPeriod = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildAcademicGradingService(tenantDb).createGradingPeriod(body)
        );
        return reply.code(201).send({ gradingPeriod });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/grading-periods/:id',
    { preHandler: requirePermission('school_years.edit') },
    async (request, reply) => {
      try {
        const { id } = academicIdParamsSchema.parse(request.params ?? {});
        const body = updateGradingPeriodBodySchema.parse(request.body ?? {});
        const gradingPeriod = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildAcademicGradingService(tenantDb).updateGradingPeriod(id, body)
        );
        return reply.send({ gradingPeriod });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/grading-periods/:id',
    { preHandler: requirePermission('school_years.edit') },
    async (request, reply) => {
      try {
        const { id } = academicIdParamsSchema.parse(request.params ?? {});
        await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildAcademicGradingService(tenantDb).deleteGradingPeriod(id)
        );
        return reply.code(204).send();
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/academic/teacher-context',
    { preHandler: requireTeacher },
    async (request, reply) => {
      try {
        const result = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildAcademicGradingService(tenantDb).getTeacherAcademicContext(request.user!.userId)
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/evaluations/scope',
    { preHandler: requireTeacher },
    async (request, reply) => {
      try {
        const query = evaluationsScopeQuerySchema.parse(request.query ?? {});
        const result = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildAcademicGradingService(tenantDb).listEvaluationsForTeacher(
            query.classId,
            query.gradingPeriodId,
            request.user!.userId
          )
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post('/api/v1/evaluations', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const body = createEvaluationBodySchema.parse(request.body ?? {});
      const evaluation = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
        tenantDb.transaction((tx) =>
          buildAcademicGradingService(tx).createEvaluation(body, request.user!.userId)
        )
      );
      return reply.code(201).send({ evaluation });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post('/api/v1/evaluations/spontaneous', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const body = spontaneousGradeBodySchema.parse(request.body ?? {});
      const result = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
        tenantDb.transaction((tx) =>
          buildAcademicGradingService(tx).createSpontaneousGrade(body, request.user!.userId)
        )
      );
      return reply.code(201).send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.put(
    '/api/v1/evaluations/:id/grades',
    { preHandler: requireTeacher },
    async (request, reply) => {
      try {
        const { id } = academicIdParamsSchema.parse(request.params ?? {});
        const body = upsertEvaluationGradeBodySchema.parse(request.body ?? {});
        const result = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          tenantDb.transaction((tx) =>
            buildAcademicGradingService(tx).upsertGrade(id, body, request.user!.userId)
          )
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.put(
    '/api/v1/class-subject-completion',
    { preHandler: requireTeacher },
    async (request, reply) => {
      try {
        const body = completionBodySchema.parse(request.body ?? {});
        const completion = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildAcademicGradingService(tenantDb).updateCompletion(body, request.user!.userId)
        );
        return reply.send({ completion });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/report-cards/completion',
    { preHandler: requirePermission('report_cards.view') },
    async (request, reply) => {
      try {
        const query = completionQuerySchema.parse(request.query ?? {});
        const result = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildAcademicGradingService(tenantDb).getCompletion(query.classId, query.gradingPeriodId)
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
