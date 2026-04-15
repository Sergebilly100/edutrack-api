import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { db as defaultGlobalDb } from '../../shared/database/db.js';

import {
  DocumentsRepository,
  type DocumentEntityType,
  type DocumentRow,
  type DocumentType,
} from './documents.repository.js';

const ALLOWED_DOCUMENT_TYPES = new Set<DocumentType>([
  'diplome',
  'cni',
  'contrat',
  'releve_notes',
  'photo',
  'autre',
]);

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png']);

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

const SIGNED_URL_DURATION_SECONDS = 3600;
const DEFAULT_LOCAL_STORAGE_ROOT = '/tmp/edutrack-docs';

type ServiceDependencies = {
  localStorageRoot: string;
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
  r2Endpoint?: string;
};

const DEFAULT_DEPENDENCIES: ServiceDependencies = {
  localStorageRoot: process.env.DOCUMENTS_LOCAL_STORAGE_ROOT ?? DEFAULT_LOCAL_STORAGE_ROOT,
  r2AccountId: process.env.R2_ACCOUNT_ID ?? '',
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  r2Bucket: process.env.R2_BUCKET_NAME ?? '',
  r2Endpoint: process.env.R2_ENDPOINT,
};

export class DocumentsModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'DocumentsModuleError';
  }
}

type UploadInput = {
  schemaName: string;
  uploadedBy: string;
  entityType: DocumentEntityType;
  entityId: string;
  type: string;
  name: string;
  fileName: string;
  fileBuffer: Buffer;
  contentType?: string;
  baseUrl: string;
};

type ListInput = {
  entityType: DocumentEntityType;
  entityId: string;
  baseUrl: string;
};

type DownloadInput = {
  schemaName: string;
  documentId: string;
  adminId: string;
  ipAddress: string;
  baseUrl: string;
};

type DeleteInput = {
  documentId: string;
};

export type DocumentItem = {
  id: string;
  entityType: DocumentEntityType;
  entityId: string;
  type: DocumentType;
  name: string;
  uploadedBy: string;
  createdAt: string;
  url: string;
};

export type DocumentMetadata = {
  id: string;
  entityType: DocumentEntityType;
  entityId: string;
};

export class DocumentsService {
  private readonly deps: ServiceDependencies;
  private readonly s3Client: S3Client | null;

  constructor(
    private readonly repository: DocumentsRepository,
    deps: Partial<ServiceDependencies> = {}
  ) {
    this.deps = {
      ...DEFAULT_DEPENDENCIES,
      ...deps,
    };

    this.s3Client = this.buildS3Client();
  }

  private buildS3Client(): S3Client | null {
    if (!this.isR2Enabled()) {
      return null;
    }

    const endpoint =
      this.deps.r2Endpoint ?? `https://${this.deps.r2AccountId}.r2.cloudflarestorage.com`;

    return new S3Client({
      region: 'auto',
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.deps.r2AccessKeyId,
        secretAccessKey: this.deps.r2SecretAccessKey,
      },
    });
  }

  private isR2Enabled(): boolean {
    return (
      this.deps.r2AccountId.trim().length > 0 &&
      this.deps.r2AccessKeyId.trim().length > 0 &&
      this.deps.r2SecretAccessKey.trim().length > 0 &&
      this.deps.r2Bucket.trim().length > 0
    );
  }

  isLocalStorageMode(): boolean {
    return !this.isR2Enabled();
  }

  private static toIsoDateTime(value: Date | string): string {
    if (value instanceof Date) {
      return value.toISOString();
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return new Date().toISOString();
    }

    return parsed.toISOString();
  }

  private static normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  private static getExtension(fileName: string): string {
    return path.extname(fileName).toLowerCase();
  }

  private static getContentType(fileName: string, declaredContentType?: string): string {
    const extension = DocumentsService.getExtension(fileName);
    const byExtension = CONTENT_TYPE_BY_EXTENSION[extension];
    if (byExtension) {
      return byExtension;
    }

    return declaredContentType ?? 'application/octet-stream';
  }

  private static validateDocumentType(value: string): DocumentType {
    if (!ALLOWED_DOCUMENT_TYPES.has(value as DocumentType)) {
      throw new DocumentsModuleError('Invalid document type', 400, 'INVALID_DOCUMENT_TYPE');
    }

    return value as DocumentType;
  }

  private static validateExtension(fileName: string): string {
    const extension = DocumentsService.getExtension(fileName);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new DocumentsModuleError('Invalid file extension', 400, 'INVALID_FILE_EXTENSION');
    }

    return extension;
  }

  private static safeAction(action: string): string {
    return action.length > 100 ? action.slice(0, 100) : action;
  }

  private static buildSafeLocalPath(rootDir: string, key: string): string {
    const cleaned = key.replace(/^\/+/, '');
    const normalizedRoot = path.resolve(rootDir);
    const absolute = path.resolve(normalizedRoot, cleaned);

    if (!absolute.startsWith(normalizedRoot + path.sep) && absolute !== normalizedRoot) {
      throw new DocumentsModuleError('Invalid local document path', 400, 'INVALID_DOCUMENT_PATH');
    }

    return absolute;
  }

  private async assertEntityExists(entityType: DocumentEntityType, entityId: string): Promise<void> {
    const exists =
      entityType === 'teacher'
        ? await this.repository.teacherExists(entityId)
        : await this.repository.studentExists(entityId);

    if (!exists) {
      throw new DocumentsModuleError(
        `${entityType === 'teacher' ? 'Teacher' : 'Student'} not found`,
        404,
        'ENTITY_NOT_FOUND'
      );
    }
  }

  private async writeLocalObject(key: string, fileBuffer: Buffer): Promise<void> {
    const absolutePath = DocumentsService.buildSafeLocalPath(this.deps.localStorageRoot, key);
    const parent = path.dirname(absolutePath);

    await mkdir(parent, { recursive: true });
    await writeFile(absolutePath, fileBuffer);
  }

  private async deleteLocalObject(key: string): Promise<void> {
    const absolutePath = DocumentsService.buildSafeLocalPath(this.deps.localStorageRoot, key);
    await rm(absolutePath, { force: true });
  }

  private async uploadObject(input: {
    key: string;
    fileBuffer: Buffer;
    contentType: string;
  }): Promise<void> {
    if (!this.isR2Enabled()) {
      await this.writeLocalObject(input.key, input.fileBuffer);
      return;
    }

    if (!this.s3Client) {
      throw new DocumentsModuleError('R2 client not initialized', 500, 'R2_NOT_INITIALIZED');
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.deps.r2Bucket,
        Key: input.key,
        Body: input.fileBuffer,
        ContentType: input.contentType,
      })
    );
  }

  private async deleteObject(key: string): Promise<void> {
    if (!this.isR2Enabled()) {
      await this.deleteLocalObject(key);
      return;
    }

    if (!this.s3Client) {
      throw new DocumentsModuleError('R2 client not initialized', 500, 'R2_NOT_INITIALIZED');
    }

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.deps.r2Bucket,
        Key: key,
      })
    );
  }

  private async signObjectUrl(key: string): Promise<string> {
    if (!this.isR2Enabled()) {
      const absolutePath = DocumentsService.buildSafeLocalPath(this.deps.localStorageRoot, key);
      const expiration = Math.floor(Date.now() / 1000) + SIGNED_URL_DURATION_SECONDS;
      return `file://${absolutePath}?expires=${expiration}`;
    }

    if (!this.s3Client) {
      throw new DocumentsModuleError('R2 client not initialized', 500, 'R2_NOT_INITIALIZED');
    }

    const command = new GetObjectCommand({
      Bucket: this.deps.r2Bucket,
      Key: key,
    });

    return getSignedUrl(this.s3Client, command, {
      expiresIn: SIGNED_URL_DURATION_SECONDS,
    });
  }

  private toDocumentItem(row: DocumentRow, url: string): DocumentItem {
    return {
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      type: row.type,
      name: row.name,
      uploadedBy: row.uploaded_by,
      createdAt: DocumentsService.toIsoDateTime(row.created_at),
      url,
    };
  }

  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata> {
    const document = await this.repository.findDocumentById(documentId);
    if (!document) {
      throw new DocumentsModuleError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }

    return {
      id: document.id,
      entityType: document.entity_type,
      entityId: document.entity_id,
    };
  }

  async listDocuments(input: ListInput): Promise<{ data: DocumentItem[] }> {
    await this.assertEntityExists(input.entityType, input.entityId);

    const rows = await this.repository.listDocuments(input.entityType, input.entityId);
    const documents = await Promise.all(
      rows.map(async (row) => {
        const url = await this.signObjectUrl(row.r2_key);
        return this.toDocumentItem(row, url);
      })
    );

    return { data: documents };
  }

  async uploadDocument(input: UploadInput): Promise<DocumentItem> {
    const documentType = DocumentsService.validateDocumentType(input.type);
    const extension = DocumentsService.validateExtension(input.fileName);

    await this.assertEntityExists(input.entityType, input.entityId);

    const tenantId = await this.repository.findTenantIdBySchemaName(input.schemaName);
    if (!tenantId) {
      throw new DocumentsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }

    const key = `${tenantId}/${input.entityType}/${input.entityId}/${randomUUID()}${extension}`;
    const contentType = DocumentsService.getContentType(input.fileName, input.contentType);

    await this.uploadObject({
      key,
      fileBuffer: input.fileBuffer,
      contentType,
    });

    let created: DocumentRow;
    try {
      created = await this.repository.createDocument({
        entityType: input.entityType,
        entityId: input.entityId,
        type: documentType,
        name: input.name,
        r2Key: key,
        uploadedBy: input.uploadedBy,
      });
    } catch (error) {
      await this.deleteObject(key);
      throw error;
    }

    const url = await this.signObjectUrl(created.r2_key);
    return this.toDocumentItem(created, url);
  }

  async createDownloadUrl(input: DownloadInput): Promise<{ id: string; url: string }> {
    const document = await this.repository.findDocumentById(input.documentId);
    if (!document) {
      throw new DocumentsModuleError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }

    const tenantId = await this.repository.findTenantIdBySchemaName(input.schemaName);
    if (tenantId) {
      await this.repository.logAdminAccess({
        adminId: input.adminId,
        tenantId,
        action: DocumentsService.safeAction(`GET /api/v1/documents/${input.documentId}/download`),
        ipAddress: input.ipAddress,
      });
    }

    const url = await this.signObjectUrl(document.r2_key);
    return {
      id: document.id,
      url,
    };
  }

  async deleteDocument(input: DeleteInput): Promise<{ id: string; deleted: true }> {
    const document = await this.repository.findDocumentById(input.documentId);
    if (!document) {
      throw new DocumentsModuleError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }

    await this.deleteObject(document.r2_key);

    const deleted = await this.repository.deleteDocument(input.documentId);
    if (!deleted) {
      throw new DocumentsModuleError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }

    return {
      id: input.documentId,
      deleted: true,
    };
  }
}

export const buildDocumentsService = (
  tenantDb: ConstructorParameters<typeof DocumentsRepository>[0],
  globalDb: ConstructorParameters<typeof DocumentsRepository>[1] = defaultGlobalDb
): DocumentsService => new DocumentsService(new DocumentsRepository(tenantDb, globalDb));
