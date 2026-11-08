import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type TenantRow = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
  verifyAccessToken: vi.fn(),
  dbExecute: vi.fn(),
  tenants: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../src/shared/database/db.js', () => ({ withTenantSchema: mocks.withTenantSchema }));

vi.mock('../../src/modules/auth/auth.service.js', async () => {
  const actual = await vi.importActual('../../src/modules/auth/auth.service.js');
  return { ...actual, verifyAccessToken: mocks.verifyAccessToken };
});

// Dépôt remplacé par une mémoire par école : les tests portent sur le service et les routes réels.
vi.mock('../../src/modules/permissions/school-identity.repository.js', () => {
  const empty = (): TenantRow => ({
    logo_url: null, logo_file_name: null, logo_mime: null, logo_size_bytes: null, logo_width: null, logo_height: null, logo_updated_at: null,
    seal_original_key: null, seal_processed_key: null, seal_file_name: null, seal_mime: null, seal_size_bytes: null,
    seal_width: null, seal_height: null, seal_remove_white: false, seal_updated_at: null,
    stamp_image_url: null, signature_image_url: null,
  });
  const row = (schema: string): TenantRow => {
    if (!mocks.tenants.has(schema)) mocks.tenants.set(schema, empty());
    return mocks.tenants.get(schema)!;
  };
  class SchoolIdentityRepository {
    async getIdentity(schema: string) { return { ...row(schema) }; }
    async replaceSeal(schema: string, seal: Record<string, unknown>) {
      const r = row(schema);
      const previous = { previousOriginalKey: r.seal_original_key, previousProcessedKey: r.seal_processed_key };
      Object.assign(r, {
        seal_original_key: seal.originalKey, seal_processed_key: seal.processedKey, seal_file_name: seal.fileName,
        seal_mime: seal.mime, seal_size_bytes: seal.sizeBytes, seal_width: seal.width, seal_height: seal.height,
        seal_remove_white: seal.removeWhite, seal_updated_at: new Date(),
      });
      return previous;
    }
    async replaceProcessedSeal(schema: string, input: Record<string, unknown>) {
      const r = row(schema);
      const previous = r.seal_processed_key;
      Object.assign(r, { seal_processed_key: input.processedKey, seal_remove_white: input.removeWhite, seal_width: input.width, seal_height: input.height });
      return previous;
    }
    async clearSeal(schema: string) {
      const r = row(schema);
      const previous = { originalKey: r.seal_original_key, processedKey: r.seal_processed_key };
      Object.assign(r, empty(), { logo_url: r.logo_url, stamp_image_url: r.stamp_image_url, signature_image_url: r.signature_image_url });
      return previous;
    }
    async replaceLogo(schema: string, logo: Record<string, unknown> | null) {
      const r = row(schema);
      const previous = r.logo_url;
      Object.assign(r, { logo_url: logo?.url ?? null, logo_file_name: logo?.fileName ?? null, logo_mime: logo?.mime ?? null, logo_size_bytes: logo?.sizeBytes ?? null, logo_width: logo?.width ?? null, logo_height: logo?.height ?? null });
      return previous;
    }
    async clearLegacySeal(schema: string, kind: 'stamp' | 'signature') {
      const r = row(schema);
      const column = kind === 'stamp' ? 'stamp_image_url' : 'signature_image_url';
      const previous = r[column];
      r[column] = null;
      return previous;
    }
  }
  return { SchoolIdentityRepository };
});

import schoolIdentityController from '../../src/modules/permissions/school-identity.controller.js';
import type { IdentityStorage } from '../../src/modules/permissions/school-identity.service.js';

const objects = new Map<string, Buffer>();
const storage: IdentityStorage = {
  isConfigured: () => true,
  putPrivate: vi.fn(async (key: string, body: Buffer) => { objects.set(key, body); }),
  putPublic: vi.fn(async (key: string, body: Buffer) => { objects.set(key, body); return `https://cdn.test/${key}`; }),
  read: vi.fn(async (key: string) => {
    const found = objects.get(key);
    if (!found) throw new Error('missing');
    return found;
  }),
  remove: vi.fn(async (key: string) => { objects.delete(key); }),
  keyFromPublicUrl: (url) => (url?.startsWith('https://cdn.test/') ? url.slice('https://cdn.test/'.length) : null),
};

const buildApp = async () => {
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(schoolIdentityController, { storage });
  await app.ready();
  return app;
};

const BASE = '/api/v1/permissions/config/school';
const schoolRow = { name: 'Ecole', subdomain: 'a', plan: 'pro', city: 'Abidjan', teaching_type: 'general', max_users: 10, max_admin_positions: 5, can_edit_sms_template: false, allow_teacher_qr_skip: false, logo_url: null, active_school_year: '2025-2026' };

const authAs = (role: 'director' | 'staff', schemaName = 'school_a') => {
  mocks.verifyAccessToken.mockResolvedValue({ sub: `${role}-id`, role, schemaName });
  // Auth : config de l'école, puis (hors directeur) postes assignés = aucun.
  mocks.dbExecute.mockResolvedValue({ rows: [schoolRow] });
};

const makeImage = async (options: { width?: number; height?: number; format?: 'png' | 'jpeg' | 'webp' } = {}) => {
  const { width = 600, height = 300, format = 'png' } = options;
  const base = sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: { create: { width: 80, height: 50, channels: 3, background: { r: 0, g: 0, b: 90 } } }, left: 40, top: 40 }]);
  return format === 'png' ? base.png().toBuffer() : format === 'jpeg' ? base.jpeg().toBuffer() : base.webp().toBuffer();
};

const multipartBody = (fileName: string, content: Buffer, mime = 'image/png') => {
  const boundary = '----test-boundary';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: 'Bearer t' } };
};

const upload = async (app: Awaited<ReturnType<typeof buildApp>>, method: 'POST' | 'PUT', url: string, fileName: string, content: Buffer, mime?: string) => {
  const { payload, headers } = multipartBody(fileName, content, mime);
  return app.inject({ method, url, payload, headers });
};

beforeEach(() => {
  vi.clearAllMocks();
  objects.clear();
  mocks.tenants.clear();
  mocks.withTenantSchema.mockImplementation(async (_schema: string, cb: (db: unknown) => unknown) => cb({ execute: mocks.dbExecute }));
  authAs('director');
});

const auth = { authorization: 'Bearer t' };

describe('permissions : settings.school appliqué côté API', () => {
  it('refuse toutes les actions à un utilisateur sans la permission', async () => {
    mocks.verifyAccessToken.mockResolvedValue({ sub: 'staff-id', role: 'staff', schemaName: 'school_a' });
    mocks.dbExecute.mockResolvedValueOnce({ rows: [schoolRow] }).mockResolvedValue({ rows: [] });
    const app = await buildApp();
    const image = await makeImage();

    const calls = await Promise.all([
      app.inject({ method: 'GET', url: `${BASE}/identity`, headers: auth }),
      app.inject({ method: 'GET', url: `${BASE}/seal/image`, headers: auth }),
      app.inject({ method: 'PATCH', url: `${BASE}/seal/background`, headers: { ...auth, 'content-type': 'application/json' }, payload: '{"removeWhite":true}' }),
      app.inject({ method: 'DELETE', url: `${BASE}/seal`, headers: auth }),
      app.inject({ method: 'DELETE', url: `${BASE}/logo`, headers: auth }),
      app.inject({ method: 'POST', url: `${BASE}/logo/from-url`, headers: { ...auth, 'content-type': 'application/json' }, payload: '{"url":"https://exemple.ci/a.png"}' }),
      upload(app, 'PUT', `${BASE}/seal`, 'a.png', image),
      upload(app, 'POST', `${BASE}/image-preview?kind=seal`, 'a.png', image),
      upload(app, 'POST', `${BASE}/logo`, 'a.png', image),
    ]);
    for (const response of calls) expect(response.statusCode).toBe(403);
    expect(storage.putPrivate).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('image unique cachet-signature', () => {
  it('aperçu : valide et traite sans rien enregistrer', async () => {
    const app = await buildApp();
    const response = await upload(app, 'POST', `${BASE}/image-preview?kind=seal&removeWhite=true`, 'cachet.png', await makeImage());
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-source-width']).toBe('600');
    expect(storage.putPrivate).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);
    await app.close();
  });

  it('enregistre, expose les métadonnées, sert l’image en flux authentifié non mis en cache', async () => {
    const app = await buildApp();
    const saved = await upload(app, 'PUT', `${BASE}/seal?removeWhite=true`, 'cachet-directeur.jpg', await makeImage({ format: 'jpeg' }), 'image/jpeg');
    expect(saved.statusCode).toBe(200);
    const body = saved.json();
    expect(body.seal).toMatchObject({ fileName: 'cachet-directeur.jpg', mime: 'image/jpeg', removeWhite: true, width: 600, height: 300 });
    expect(JSON.stringify(body)).not.toContain('school-seals/'); // aucune clé ni URL de stockage exposée

    expect([...objects.keys()].every((key) => key.startsWith('school-seals/school_a/'))).toBe(true);
    expect(objects.size).toBe(2);

    const image = await app.inject({ method: 'GET', url: `${BASE}/seal/image`, headers: auth });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cache-control']).toBe('private, no-store');
    expect(image.headers['x-content-type-options']).toBe('nosniff');

    const original = await app.inject({ method: 'GET', url: `${BASE}/seal/image?variant=original`, headers: auth });
    expect(original.headers['content-type']).toBe('image/jpeg');
    await app.close();
  });

  it('remplacer supprime les anciens objets (dernier enregistrement gagnant, pas d’orphelin)', async () => {
    const app = await buildApp();
    await upload(app, 'PUT', `${BASE}/seal`, 'un.png', await makeImage());
    const firstKeys = new Set(objects.keys());
    await upload(app, 'PUT', `${BASE}/seal`, 'deux.png', await makeImage({ width: 800, height: 400 }));
    expect(objects.size).toBe(2);
    for (const key of firstKeys) expect(objects.has(key)).toBe(false);
    const identity = await app.inject({ method: 'GET', url: `${BASE}/identity`, headers: auth });
    expect(identity.json().seal.fileName).toBe('deux.png');
    await app.close();
  });

  it('retrait du fond blanc : recalculé depuis l’original conservé, réversible', async () => {
    const app = await buildApp();
    await upload(app, 'PUT', `${BASE}/seal`, 'c.png', await makeImage());
    const originalKey = [...objects.keys()].find((key) => key.includes('-original.'))!;

    const on = await app.inject({ method: 'PATCH', url: `${BASE}/seal/background`, headers: { ...auth, 'content-type': 'application/json' }, payload: '{"removeWhite":true}' });
    expect(on.statusCode).toBe(200);
    expect(on.json().seal.removeWhite).toBe(true);
    const processedOn = (await app.inject({ method: 'GET', url: `${BASE}/seal/image`, headers: auth })).rawPayload;
    const alphaOn = (await sharp(processedOn).ensureAlpha().raw().toBuffer())[3];
    expect(alphaOn).toBe(0);

    const off = await app.inject({ method: 'PATCH', url: `${BASE}/seal/background`, headers: { ...auth, 'content-type': 'application/json' }, payload: '{"removeWhite":false}' });
    expect(off.json().seal.removeWhite).toBe(false);
    const processedOff = (await app.inject({ method: 'GET', url: `${BASE}/seal/image`, headers: auth })).rawPayload;
    expect((await sharp(processedOff).ensureAlpha().raw().toBuffer())[3]).toBe(255);

    expect(objects.has(originalKey)).toBe(true); // l'original n'a jamais bougé
    expect(objects.size).toBe(2);
    await app.close();
  });

  it('suppression : retire l’image et ses objets ; lecture ensuite en 404', async () => {
    const app = await buildApp();
    await upload(app, 'PUT', `${BASE}/seal`, 'c.png', await makeImage());
    const deleted = await app.inject({ method: 'DELETE', url: `${BASE}/seal`, headers: auth });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().seal).toBeNull();
    expect(objects.size).toBe(0);
    expect((await app.inject({ method: 'GET', url: `${BASE}/seal/image`, headers: auth })).statusCode).toBe(404);
    await app.close();
  });

  it.each([
    ['SVG', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"/>'), 'image/svg+xml', 'INVALID_FILE_TYPE'],
    ['PDF renommé en png', 'faux.png', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj'), 'image/png', 'INVALID_FILE_TYPE'],
    ['fichier corrompu', 'casse.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 3)]), 'image/png', 'IMAGE_CORRUPTED'],
    ['trop lourd', 'gros.png', Buffer.alloc(2 * 1024 * 1024 + 10, 1), 'image/png', 'FILE_TOO_LARGE'],
  ])('refuse : %s', async (_label, fileName, content, mime, code) => {
    const app = await buildApp();
    const response = await upload(app, 'PUT', `${BASE}/seal`, fileName, content, mime);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code, statusCode: 400 });
    expect(objects.size).toBe(0);
    await app.close();
  });

  it('refuse une image trop petite', async () => {
    const app = await buildApp();
    const response = await upload(app, 'PUT', `${BASE}/seal`, 'p.png', await makeImage({ width: 200, height: 100 }));
    expect(response.json().code).toBe('IMAGE_TOO_SMALL');
    await app.close();
  });

  it('isolation : une autre école ne voit ni ne lit l’image', async () => {
    const app = await buildApp();
    await upload(app, 'PUT', `${BASE}/seal`, 'c.png', await makeImage());

    authAs('director', 'school_b');
    const identity = await app.inject({ method: 'GET', url: `${BASE}/identity`, headers: auth });
    expect(identity.json().seal).toBeNull();
    expect((await app.inject({ method: 'GET', url: `${BASE}/seal/image`, headers: auth })).statusCode).toBe(404);

    await upload(app, 'PUT', `${BASE}/seal`, 'b.png', await makeImage());
    expect([...objects.keys()].filter((key) => key.startsWith('school-seals/school_b/')).length).toBe(2);
    expect([...objects.keys()].filter((key) => key.startsWith('school-seals/school_a/')).length).toBe(2);
    await app.close();
  });

  it('anciennes images : visibles, suppression individuelle, objets retirés', async () => {
    mocks.tenants.set('school_a', { stamp_image_url: 'https://cdn.test/seals/school_a/stamp/x.png', signature_image_url: 'https://cdn.test/seals/school_a/signature/y.png', seal_remove_white: false });
    objects.set('seals/school_a/stamp/x.png', Buffer.from('x'));
    objects.set('seals/school_a/signature/y.png', Buffer.from('y'));
    const app = await buildApp();

    const identity = await app.inject({ method: 'GET', url: `${BASE}/identity`, headers: auth });
    expect(identity.json().legacy).toEqual({ stamp: true, signature: true });
    expect(JSON.stringify(identity.json())).not.toContain('cdn.test'); // pas d'URL publique renvoyée

    const read = await app.inject({ method: 'GET', url: `${BASE}/seal/legacy/stamp/image`, headers: auth });
    expect(read.statusCode).toBe(200);

    const removed = await app.inject({ method: 'DELETE', url: `${BASE}/seal/legacy/stamp`, headers: auth });
    expect(removed.json().legacy).toEqual({ stamp: false, signature: true });
    expect(objects.has('seals/school_a/stamp/x.png')).toBe(false);
    expect(objects.has('seals/school_a/signature/y.png')).toBe(true);
    await app.close();
  });
});

describe('logo', () => {
  it('importe un logo valide, avec métadonnées', async () => {
    const app = await buildApp();
    const response = await upload(app, 'POST', `${BASE}/logo`, 'logo-flamboyants.png', await makeImage({ width: 400, height: 400 }));
    expect(response.statusCode).toBe(200);
    expect(response.json().logoUrl).toMatch(/^https:\/\/cdn\.test\/logos\/school_a\/.+\.png$/);
    expect(response.json().logo).toMatchObject({ fileName: 'logo-flamboyants.png', mime: 'image/png' });
    await app.close();
  });

  it('refuse tout nouveau SVG', async () => {
    const app = await buildApp();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><script>alert(1)</script></svg>');
    const response = await upload(app, 'POST', `${BASE}/logo`, 'logo.svg', svg, 'image/svg+xml');
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_FILE_TYPE');
    expect(objects.size).toBe(0);
    await app.close();
  });

  it('suppression du logo : retire la référence et l’objet', async () => {
    const app = await buildApp();
    await upload(app, 'POST', `${BASE}/logo`, 'l.png', await makeImage({ width: 300, height: 300 }));
    expect(objects.size).toBe(1);
    const response = await app.inject({ method: 'DELETE', url: `${BASE}/logo`, headers: auth });
    expect(response.json().logo).toBeNull();
    expect(objects.size).toBe(0);
    await app.close();
  });

  it.each([
    ['http://exemple.ci/logo.png', 'INVALID_URL'],
    ['https://127.0.0.1/logo.png', 'FORBIDDEN_HOST'],
    ['https://169.254.169.254/latest/meta-data', 'FORBIDDEN_HOST'],
    ['https://[::1]/logo.png', 'FORBIDDEN_HOST'],
  ])('adresse d’image refusée : %s', async (url, code) => {
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: `${BASE}/logo/from-url`, headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify({ url }) });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe(code);
    expect(objects.size).toBe(0);
    await app.close();
  });
});
