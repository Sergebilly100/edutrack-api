import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), readR2Buffer: vi.fn(), loadLogo: vi.fn() }));

vi.mock('../../src/shared/database/db.js', () => ({ db: { execute: mocks.execute } }));
vi.mock('../../src/shared/storage/r2.js', () => ({ readR2Buffer: mocks.readR2Buffer }));
vi.mock('../../src/shared/pdf/branding.js', () => ({ loadLogo: mocks.loadLogo }));

import { loadSchoolSealsForBulletin } from '../../src/shared/pdf/school-seal.js';

const logger = { warn: vi.fn() };
const legacyStamp = { bytes: new Uint8Array([1]), format: 'png' as const };
const legacySignature = { bytes: new Uint8Array([2]), format: 'jpg' as const };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadLogo.mockImplementation(async (url: string | null) =>
    url === 'https://cdn/stamp.png' ? legacyStamp : url === 'https://cdn/sig.jpg' ? legacySignature : null
  );
});

describe('loadSchoolSealsForBulletin', () => {
  it('image unique présente : renvoie la version traitée (png) et ne lit pas les anciennes images', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    mocks.execute.mockResolvedValue({ rows: [{ seal_processed_key: 'school-seals/s/x-processed.png', stamp_image_url: 'https://cdn/stamp.png', signature_image_url: null }] });
    mocks.readR2Buffer.mockResolvedValue(png);

    const result = await loadSchoolSealsForBulletin('school_a', logger);
    expect(result.unified?.format).toBe('png');
    expect(Buffer.from(result.unified!.bytes).equals(png)).toBe(true);
    expect(result.legacy).toEqual({ stamp: null, signature: null });
    expect(mocks.loadLogo).not.toHaveBeenCalled();
  });

  it('image unique absente : repli sur les anciennes images séparées', async () => {
    mocks.execute.mockResolvedValue({ rows: [{ seal_processed_key: null, stamp_image_url: 'https://cdn/stamp.png', signature_image_url: 'https://cdn/sig.jpg' }] });
    const result = await loadSchoolSealsForBulletin('school_a', logger);
    expect(result.unified).toBeNull();
    expect(result.legacy).toEqual({ stamp: legacyStamp, signature: legacySignature });
  });

  it('aucune image : tout est null', async () => {
    mocks.execute.mockResolvedValue({ rows: [{ seal_processed_key: null, stamp_image_url: null, signature_image_url: null }] });
    expect(await loadSchoolSealsForBulletin('school_a')).toEqual({ unified: null, legacy: { stamp: null, signature: null } });
  });

  it('image unique illisible : pas d’exception, repli sur les anciennes images, journal sans contenu', async () => {
    mocks.execute.mockResolvedValue({ rows: [{ seal_processed_key: 'school-seals/s/x-processed.png', stamp_image_url: 'https://cdn/stamp.png', signature_image_url: null }] });
    mocks.readR2Buffer.mockRejectedValue(new Error('NoSuchKey'));
    const result = await loadSchoolSealsForBulletin('school_a', logger);
    expect(result.unified).toBeNull();
    expect(result.legacy.stamp).toBe(legacyStamp);
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('school_a');
    expect(logged).not.toContain('school-seals/'); // pas de clé de stockage dans les logs
  });

  it('erreur base de données : renvoie un résultat vide sans lever', async () => {
    mocks.execute.mockRejectedValue(new Error('connection lost'));
    await expect(loadSchoolSealsForBulletin('school_a', logger)).resolves.toEqual({ unified: null, legacy: { stamp: null, signature: null } });
  });

  it('école introuvable : résultat vide', async () => {
    mocks.execute.mockResolvedValue({ rows: [] });
    expect((await loadSchoolSealsForBulletin('inconnue')).unified).toBeNull();
  });
});
