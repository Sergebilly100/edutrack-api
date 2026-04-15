import { sql } from 'drizzle-orm';

export type QueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

export type DocumentEntityType = 'teacher' | 'student';

export type DocumentType =
  | 'diplome'
  | 'cni'
  | 'contrat'
  | 'releve_notes'
  | 'photo'
  | 'autre';

export type DocumentRow = {
  id: string;
  entity_type: DocumentEntityType;
  entity_id: string;
  type: DocumentType;
  name: string;
  r2_key: string;
  uploaded_by: string;
  created_at: Date;
};

type IdRow = { id: string };

type TenantRow = { id: string };

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows?: T[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

export class DocumentsRepository {
  constructor(
    private readonly tenantDb: QueryExecutor,
    private readonly globalDb: QueryExecutor
  ) {}

  async findTenantIdBySchemaName(schemaName: string): Promise<string | null> {
    const result = await this.globalDb.execute(sql`
      SELECT id
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);

    return getRows<TenantRow>(result)[0]?.id ?? null;
  }

  async teacherExists(teacherId: string): Promise<boolean> {
    const result = await this.tenantDb.execute(sql`
      SELECT id
      FROM teachers
      WHERE id = ${teacherId}
      LIMIT 1
    `);

    return Boolean(getRows<IdRow>(result)[0]?.id);
  }

  async studentExists(studentId: string): Promise<boolean> {
    const result = await this.tenantDb.execute(sql`
      SELECT id
      FROM students
      WHERE id = ${studentId}
      LIMIT 1
    `);

    return Boolean(getRows<IdRow>(result)[0]?.id);
  }

  async createDocument(input: {
    entityType: DocumentEntityType;
    entityId: string;
    type: DocumentType;
    name: string;
    r2Key: string;
    uploadedBy: string;
  }): Promise<DocumentRow> {
    const result = await this.tenantDb.execute(sql`
      INSERT INTO documents (entity_type, entity_id, type, name, r2_key, uploaded_by)
      VALUES (
        ${input.entityType}::document_entity_type,
        ${input.entityId},
        ${input.type},
        ${input.name},
        ${input.r2Key},
        ${input.uploadedBy}
      )
      RETURNING id, entity_type, entity_id, type, name, r2_key, uploaded_by, created_at
    `);

    const created = getRows<DocumentRow>(result)[0];
    if (!created) {
      throw new Error('Failed to create document');
    }

    return created;
  }

  async listDocuments(entityType: DocumentEntityType, entityId: string): Promise<DocumentRow[]> {
    const result = await this.tenantDb.execute(sql`
      SELECT id, entity_type, entity_id, type, name, r2_key, uploaded_by, created_at
      FROM documents
      WHERE entity_type = ${entityType}::document_entity_type
        AND entity_id = ${entityId}
      ORDER BY created_at DESC
    `);

    return getRows<DocumentRow>(result);
  }

  async findDocumentById(documentId: string): Promise<DocumentRow | null> {
    const result = await this.tenantDb.execute(sql`
      SELECT id, entity_type, entity_id, type, name, r2_key, uploaded_by, created_at
      FROM documents
      WHERE id = ${documentId}
      LIMIT 1
    `);

    return getRows<DocumentRow>(result)[0] ?? null;
  }

  async deleteDocument(documentId: string): Promise<boolean> {
    const result = await this.tenantDb.execute(sql`
      DELETE FROM documents
      WHERE id = ${documentId}
      RETURNING id
    `);

    return Boolean(getRows<IdRow>(result)[0]?.id);
  }

  async logAdminAccess(input: {
    adminId: string;
    tenantId: string;
    action: string;
    ipAddress: string | null;
  }): Promise<void> {
    await this.globalDb.execute(sql`
      INSERT INTO public.admin_access_log (admin_id, tenant_id, action, ip_address)
      VALUES (${input.adminId}, ${input.tenantId}, ${input.action}, ${input.ipAddress})
    `);
  }
}
