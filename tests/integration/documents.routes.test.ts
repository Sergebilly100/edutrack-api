import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
  requireDirectorOrSecretary: vi.fn(),
  buildDocumentsService: vi.fn(),
  listDocuments: vi.fn(),
  getDocumentMetadata: vi.fn(),
  createDownloadUrl: vi.fn(),
  getDownloadPayload: vi.fn(),
  deleteDocument: vi.fn(),
  uploadDocument: vi.fn(),
  replaceDocument: vi.fn(),
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

vi.mock('../../src/shared/middleware/auth.middleware.js', () => ({
  requireDirectorOrSecretary: mocks.requireDirectorOrSecretary,
}));

vi.mock('../../src/modules/documents/documents.service.js', async () => {
  const actual = await vi.importActual('../../src/modules/documents/documents.service.js');
  return {
    ...actual,
    buildDocumentsService: mocks.buildDocumentsService,
  };
});

import documentsController from '../../src/modules/documents/documents.controller.js';

const ENTITY_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';

const buildApp = async () => {
  const app = Fastify();
  await app.register(multipart);
  await app.register(documentsController);
  await app.ready();
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.requireDirectorOrSecretary.mockImplementation(async (request: { claims?: unknown }) => {
    request.claims = {
      sub: 'director-id',
      role: 'director',
      schemaName: 'school_sainte_marie',
    };
  });

  mocks.withTenantSchema.mockImplementation(async (_schemaName, callback) => callback({ execute: vi.fn() }));
  mocks.buildDocumentsService.mockReturnValue({
    listDocuments: mocks.listDocuments,
    getDocumentMetadata: mocks.getDocumentMetadata,
    createDownloadUrl: mocks.createDownloadUrl,
    getDownloadPayload: mocks.getDownloadPayload,
    deleteDocument: mocks.deleteDocument,
    uploadDocument: mocks.uploadDocument,
    replaceDocument: mocks.replaceDocument,
  });

  mocks.listDocuments.mockResolvedValue({
    items: [
      {
        id: DOCUMENT_ID,
        entityType: 'teacher',
        entityId: ENTITY_ID,
        type: 'contrat',
        name: 'Contrat',
        uploadedBy: 'director-id',
        createdAt: '2026-04-23T00:00:00.000Z',
        url: 'https://example.test/file.pdf',
      },
    ],
  });
  mocks.getDocumentMetadata.mockResolvedValue({
    id: DOCUMENT_ID,
    entityType: 'teacher',
    entityId: ENTITY_ID,
  });
  mocks.createDownloadUrl.mockResolvedValue({
    url: 'https://example.test/signed-url',
  });
  mocks.getDownloadPayload.mockResolvedValue({
    id: DOCUMENT_ID,
    fileName: 'contrat.pdf',
    contentType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4'),
  });
  mocks.deleteDocument.mockResolvedValue({ success: true });
  mocks.uploadDocument.mockResolvedValue({
    id: DOCUMENT_ID,
    entityType: 'teacher',
    entityId: ENTITY_ID,
    type: 'contrat',
    name: 'Contrat de travail',
    uploadedBy: 'director-id',
    createdAt: '2026-04-23T00:00:00.000Z',
    url: 'https://example.test/file.pdf',
  });
  mocks.replaceDocument.mockResolvedValue({
    id: DOCUMENT_ID,
    entityType: 'teacher',
    entityId: ENTITY_ID,
    type: 'contrat',
    name: 'Contrat mis à jour',
    uploadedBy: 'director-id',
    createdAt: '2026-04-23T00:00:00.000Z',
    url: 'https://example.test/updated-file.pdf',
  });
});

describe('documents routes', () => {
  it('POST /api/v1/documents/:entityType/:entityId accepte un fichier multipart', async () => {
    const boundary = 'documents-test-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ncontrat\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nContrat de travail\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="contrat.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from('%PDF-1.4'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/teacher/${ENTITY_ID}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.uploadDocument).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'teacher',
      entityId: ENTITY_ID,
      type: 'contrat',
      name: 'Contrat de travail',
      fileName: 'contrat.pdf',
      fileBuffer: expect.any(Buffer),
    }));
    await app.close();
  });

  it('POST /api/v1/documents/:entityType/:entityId accepte un PDF identifié comme application/octet-stream', async () => {
    const boundary = 'documents-generic-mime-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nautre\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nJustificatif\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="justificatif.pdf"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from('%PDF-1.4'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/student/${ENTITY_ID}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.uploadDocument).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'student',
      contentType: 'application/pdf',
      fileName: 'justificatif.pdf',
    }));
    await app.close();
  });

  it('POST /api/v1/documents/:entityType/:entityId accepte le MIME historique image/jpg', async () => {
    const boundary = 'documents-jpg-mime-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nphoto\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nPhoto élève\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpg\r\n\r\n`),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/student/${ENTITY_ID}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.uploadDocument).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'image/jpeg',
      fileName: 'photo.jpg',
    }));
    await app.close();
  });

  it('GET /api/v1/documents/:entityType/:entityId retourne la liste des documents', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/teacher/${ENTITY_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.listDocuments).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('PUT /api/v1/documents/:id remplace le fichier existant', async () => {
    const boundary = 'documents-replace-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nautre\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nContrat mis à jour\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="contrat-mis-a-jour.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from('%PDF-1.4'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/documents/${DOCUMENT_ID}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.replaceDocument).toHaveBeenCalledWith(expect.objectContaining({
      documentId: DOCUMENT_ID,
      name: 'Contrat mis à jour',
      fileName: 'contrat-mis-a-jour.pdf',
    }));
    await app.close();
  });

  it('GET /api/v1/documents/:id/download retourne une URL signée', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${DOCUMENT_ID}/download`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().url).toContain('signed-url');
    expect(mocks.createDownloadUrl).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /api/v1/documents/:id/download?raw=true retourne le fichier binaire', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${DOCUMENT_ID}/download?raw=true`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(mocks.getDownloadPayload).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /api/v1/documents/:id/download retourne 400 si uuid invalide', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/documents/not-an-uuid/download',
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.getDocumentMetadata).not.toHaveBeenCalled();
    await app.close();
  });

  it('DELETE /api/v1/documents/:id supprime un document', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${DOCUMENT_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(mocks.deleteDocument).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('staff: accès documents refusé (403)', async () => {
    mocks.requireDirectorOrSecretary.mockImplementationOnce(async (request: { claims?: unknown }) => {
      request.claims = {
        sub: 'staff-id',
        role: 'staff',
        schemaName: 'school_sainte_marie',
      };
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/teacher/${ENTITY_ID}`,
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('staff: suppression document refusée (403)', async () => {
    mocks.requireDirectorOrSecretary.mockImplementationOnce(async (request: { claims?: unknown }) => {
      request.claims = {
        sub: 'staff-id',
        role: 'staff',
        schemaName: 'school_sainte_marie',
      };
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${DOCUMENT_ID}`,
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
