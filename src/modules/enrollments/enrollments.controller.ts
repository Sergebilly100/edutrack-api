import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requirePermission } from '../../shared/middleware/auth.middleware.js';
import { deleteFromR2, isR2Configured, presignDownload, uploadBuffer } from '../../shared/storage/r2.js';
import { buildEnrollmentsService, EnrollmentsModuleError } from './enrollments.service.js';
import type { PdfExportQueueHandle } from '../billing/billing.queue.js';
import { FinanceModuleError } from '../finance/finance.service.js';
import { emitEnrollmentDocumentsMissing } from './enrollments.events.js';
import {
  createEnrollmentBodySchema,
  confirmEnrollmentPaymentBodySchema,
  createRequiredDocumentTypeBodySchema,
  enrollmentListQuerySchema,
  requiredDocumentListQuerySchema,
  studentParamsSchema,
  updateEnrollmentBodySchema,
  updateRequiredDocumentTypeBodySchema,
  updateStudentDocumentBodySchema,
  upsertStudentDocumentBodySchema,
  uuidParamsSchema,
} from './enrollments.types.js';

const handleError = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', code: 'VALIDATION_ERROR', statusCode: 400, details: error.issues });
  if (error instanceof EnrollmentsModuleError) return reply.code(error.statusCode).send({ error: error.message, code: error.code, statusCode: error.statusCode });
  if (error instanceof FinanceModuleError) return reply.code(error.statusCode).send({ error: error.message, code: error.code, statusCode: error.statusCode });
  request.log.error({ err: error }, '[enrollments] Unexpected error');
  return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR', statusCode: 500 });
};

const withService = <T>(request: FastifyRequest, run: (service: ReturnType<typeof buildEnrollmentsService>) => Promise<T>) =>
  withTenantSchema(request.claims!.schemaName, (db) => run(buildEnrollmentsService(db)));

export default async function enrollmentsController(
  app: FastifyInstance,
  options: { pdfQueue?: PdfExportQueueHandle } = {}
): Promise<void> {
  app.get('/api/v1/enrollments', { preHandler: requirePermission('enrollments.view') }, async (request, reply) => {
    try {
      const query = enrollmentListQuerySchema.parse(request.query ?? {});
      return reply.send({ enrollments: await withService(request, (service) => service.listEnrollments({
        ...(query.school_year_id ? { schoolYearId: query.school_year_id } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
      })) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/enrollments/:id', { preHandler: requirePermission('enrollments.view') }, async (request, reply) => {
    try { const { id } = uuidParamsSchema.parse(request.params); return reply.send({ enrollment: await withService(request, (service) => service.getEnrollment(id)) }); }
    catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/enrollments/:id/payment-summary', { preHandler: requirePermission('enrollments.confirm_payment') }, async (request, reply) => {
    try { const { id } = uuidParamsSchema.parse(request.params); return reply.send(await withService(request, (service) => service.getPaymentSummary(id))); }
    catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/enrollments', { preHandler: requirePermission('enrollments.create') }, async (request, reply) => {
    try { const body = createEnrollmentBodySchema.parse(request.body); return reply.code(201).send(await withService(request, (service) => service.createEnrollment(body))); }
    catch (error) { return handleError(request, reply, error); }
  });

  app.patch('/api/v1/enrollments/:id', { preHandler: requirePermission('enrollments.edit') }, async (request, reply) => {
    try { const { id } = uuidParamsSchema.parse(request.params); const body = updateEnrollmentBodySchema.parse(request.body); return reply.send({ enrollment: await withService(request, (service) => service.updateEnrollment(id, body)) }); }
    catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/enrollments/:id/confirm-payment', { preHandler: requirePermission('enrollments.confirm_payment') }, async (request, reply) => {
    try {
      const { id } = uuidParamsSchema.parse(request.params);
      const body = confirmEnrollmentPaymentBodySchema.parse(request.body);
      const result = await withService(request, (service) => service.confirmPayment(id, request.user!.userId, body));
      const job = options.pdfQueue
        ? await options.pdfQueue.add('tuition-receipt', {
            type: 'tuition-receipt',
            schemaName: request.claims!.schemaName,
            paymentId: result.payment.id,
          }, { removeOnComplete: 100, removeOnFail: 100 })
        : null;
      return reply.send({ ...result, receiptJobId: job?.id });
    }
    catch (error) { return handleError(request, reply, error); }
  });

  app.delete('/api/v1/enrollments/:id', { preHandler: requirePermission('enrollments.edit') }, async (request, reply) => {
    try { const { id } = uuidParamsSchema.parse(request.params); return reply.send(await withService(request, (service) => service.deleteEnrollment(id))); }
    catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/required-document-types', { preHandler: requirePermission('enrollments.view') }, async (request, reply) => {
    try { const query = requiredDocumentListQuerySchema.parse(request.query ?? {}); return reply.send({ documentTypes: await withService(request, (service) => service.listRequiredDocumentTypes(query.level_id)) }); }
    catch (error) { return handleError(request, reply, error); }
  });
  app.get('/api/v1/required-document-levels', { preHandler: requirePermission('enrollments.view') }, async (request, reply) => {
    try { return reply.send({ levels: await withService(request, (service) => service.listRequiredDocumentLevels()) }); }
    catch (error) { return handleError(request, reply, error); }
  });
  app.post('/api/v1/required-document-types', { preHandler: requirePermission('enrollments.edit') }, async (request, reply) => {
    try { const body = createRequiredDocumentTypeBodySchema.parse(request.body); return reply.code(201).send({ documentType: await withService(request, (service) => service.createRequiredDocumentType(body)) }); }
    catch (error) { return handleError(request, reply, error); }
  });
  app.patch('/api/v1/required-document-types/:id', { preHandler: requirePermission('enrollments.edit') }, async (request, reply) => {
    try { const { id } = uuidParamsSchema.parse(request.params); const body = updateRequiredDocumentTypeBodySchema.parse(request.body); return reply.send({ documentType: await withService(request, (service) => service.updateRequiredDocumentType(id, body)) }); }
    catch (error) { return handleError(request, reply, error); }
  });
  app.delete('/api/v1/required-document-types/:id', { preHandler: requirePermission('enrollments.edit') }, async (request, reply) => {
    try { const { id } = uuidParamsSchema.parse(request.params); return reply.send(await withService(request, (service) => service.deleteRequiredDocumentType(id))); }
    catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/students/:studentId/enrollment-documents', { preHandler: requirePermission('enrollments.view') }, async (request, reply) => {
    try { const { studentId } = studentParamsSchema.parse(request.params); return reply.send({ documents: await withService(request, (service) => service.listStudentDocuments(studentId)) }); }
    catch (error) { return handleError(request, reply, error); }
  });
  app.post('/api/v1/students/:studentId/enrollment-documents/verify', { preHandler: requirePermission('enrollments.edit') }, async (request, reply) => {
    try {
      const { studentId } = studentParamsSchema.parse(request.params);
      const result = await withService(request, (service) => service.verifyStudentDocuments(studentId));
      if (result.notification) {
        emitEnrollmentDocumentsMissing({
          tenantId: request.claims!.tenantId ?? request.claims!.schemaName,
          schemaName: request.claims!.schemaName,
          studentId,
          ...result.notification,
        });
      }
      return reply.send({
        documents: result.documents,
        missingMandatoryDocuments: result.missingMandatoryDocuments,
        dossierComplete: result.dossierComplete,
        notificationQueued: result.notification !== null,
      });
    } catch (error) { return handleError(request, reply, error); }
  });
  app.post('/api/v1/students/:studentId/enrollment-documents', { preHandler: requirePermission('enrollments.edit') }, async (request, reply) => {
    try { const { studentId } = studentParamsSchema.parse(request.params); const body = upsertStudentDocumentBodySchema.parse(request.body); return reply.code(201).send({ document: await withService(request, (service) => service.upsertStudentDocument({ studentId, ...body })) }); }
    catch (error) { return handleError(request, reply, error); }
  });
  app.patch('/api/v1/student-documents/:id', { preHandler: requirePermission('enrollments.edit') }, async (request, reply) => {
    try { const { id } = uuidParamsSchema.parse(request.params); const body = updateStudentDocumentBodySchema.parse(request.body); return reply.send({ document: await withService(request, (service) => service.updateStudentDocument(id, body)) }); }
    catch (error) { return handleError(request, reply, error); }
  });
  app.get('/api/v1/student-documents/:id/download', { preHandler: requirePermission('enrollments.view') }, async (request, reply) => {
    try {
      const { id } = uuidParamsSchema.parse(request.params);
      const document = await withService(request, (service) => service.getStudentDocument(id));
      if (document.r2Key) {
        if (!isR2Configured()) throw new EnrollmentsModuleError('Document storage is unavailable', 503, 'DOCUMENT_STORAGE_UNAVAILABLE');
        return reply.send({ url: await presignDownload(document.r2Key, 300) });
      }
      if (document.fileUrl) return reply.send({ url: document.fileUrl });
      throw new EnrollmentsModuleError('Document file not found', 404, 'DOCUMENT_FILE_NOT_FOUND');
    } catch (error) { return handleError(request, reply, error); }
  });
  app.delete('/api/v1/student-documents/:id', { preHandler: requirePermission('enrollments.edit') }, async (request, reply) => {
    try {
      const { id } = uuidParamsSchema.parse(request.params);
      const document = await withService(request, (service) => service.getStudentDocument(id));
      if (document.r2Key && isR2Configured()) await deleteFromR2(document.r2Key);
      return reply.send(await withService(request, (service) => service.deleteStudentDocument(id)));
    }
    catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/students/:studentId/enrollment-documents/upload', { preHandler: requirePermission('enrollments.edit') }, async (request, reply) => {
    try {
      const { studentId } = studentParamsSchema.parse(request.params);
      if (!isR2Configured()) throw new EnrollmentsModuleError('Document storage is unavailable', 503, 'DOCUMENT_STORAGE_UNAVAILABLE');
      const file = await request.file();
      if (!file) throw new EnrollmentsModuleError('No file provided', 400, 'FILE_REQUIRED');
      const allowedMime = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
      if (!allowedMime.has(file.mimetype)) throw new EnrollmentsModuleError('Unsupported document type', 400, 'INVALID_FILE_TYPE');
      const field = file.fields.documentTypeId;
      const firstField = Array.isArray(field) ? field[0] : field;
      const documentTypeId = z.string().uuid().parse(
        firstField?.type === 'field' ? firstField.value : undefined
      );
      await withService(request, (service) => service.assertDocumentTypeAllowed(studentId, documentTypeId));
      const buffer = await file.toBuffer();
      if (buffer.length > 10 * 1024 * 1024) throw new EnrollmentsModuleError('File exceeds 10 MB', 400, 'FILE_TOO_LARGE');
      const extension = file.filename.split('.').pop()?.toLowerCase() || 'bin';
      const key = `student-documents/${request.claims!.schemaName}/${studentId}/${randomUUID()}.${extension}`;
      await uploadBuffer(key, buffer, file.mimetype);
      const document = await withService(request, (service) => service.upsertStudentDocument({ studentId, documentTypeId, status: 'provided', r2Key: key }));
      return reply.code(201).send({ document });
    } catch (error) { return handleError(request, reply, error); }
  });
}
