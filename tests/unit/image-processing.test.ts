import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  ImageValidationError,
  MAX_UPLOAD_BYTES,
  applyWhiteRemoval,
  detectImageType,
  inspectImage,
  processToPng,
  sanitizeOriginal,
  toPdfEmbeddable,
} from '../../src/shared/image/image-processing.js';

const MIN = { width: 300, height: 150 };

/** Cachet noir sur fond blanc opaque, ou fond transparent. */
const makeStamp = async (options: { width?: number; height?: number; transparent?: boolean; format?: 'png' | 'jpeg' | 'webp'; exif?: boolean } = {}) => {
  const { width = 600, height = 300, transparent = false, format = 'png', exif = false } = options;
  const background = transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 255, g: 255, b: 255, alpha: 1 };
  let pipeline = sharp({ create: { width, height, channels: 4, background } }).composite([
    { input: { create: { width: 100, height: 60, channels: 3, background: { r: 10, g: 10, b: 120 } } }, left: 50, top: 40 },
  ]);
  if (exif) pipeline = pipeline.withExif({ IFD0: { Copyright: 'Photographe Test', Make: 'TelephoneTest' } });
  if (format === 'png') return pipeline.png().toBuffer();
  if (format === 'jpeg') return pipeline.flatten({ background: '#ffffff' }).jpeg().toBuffer();
  return pipeline.webp().toBuffer();
};

describe('detectImageType', () => {
  it('reconnaît PNG, JPEG et WebP par leurs octets', async () => {
    expect(detectImageType(await makeStamp({ format: 'png' }))).toBe('png');
    expect(detectImageType(await makeStamp({ format: 'jpeg' }))).toBe('jpeg');
    expect(detectImageType(await makeStamp({ format: 'webp' }))).toBe('webp');
  });

  it('refuse SVG, PDF et texte, même renommés', () => {
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImageType(Buffer.from('%PDF-1.7 ...'))).toBeNull();
    expect(detectImageType(Buffer.from('hello'))).toBeNull();
  });
});

describe('inspectImage', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('accepte une image %s valide', async (format) => {
    const info = await inspectImage(await makeStamp({ format }), MIN);
    expect(info).toMatchObject({ type: format, width: 600, height: 300 });
  });

  it('accepte un PNG à fond transparent', async () => {
    await expect(inspectImage(await makeStamp({ transparent: true }), MIN)).resolves.toMatchObject({ type: 'png' });
  });

  it('refuse un SVG avec INVALID_FILE_TYPE', async () => {
    await expect(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), MIN)).rejects.toMatchObject({
      code: 'INVALID_FILE_TYPE',
    });
  });

  it('refuse un fichier trop lourd', async () => {
    await expect(inspectImage(Buffer.alloc(MAX_UPLOAD_BYTES + 1), MIN)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('refuse une image trop petite', async () => {
    await expect(inspectImage(await makeStamp({ width: 200, height: 100 }), MIN)).rejects.toMatchObject({
      code: 'IMAGE_TOO_SMALL',
    });
  });

  it('refuse un fichier corrompu (PNG tronqué)', async () => {
    const png = await makeStamp();
    await expect(inspectImage(png.subarray(0, Math.floor(png.length / 2)), MIN)).rejects.toBeInstanceOf(ImageValidationError);
    await expect(inspectImage(png.subarray(0, Math.floor(png.length / 2)), MIN)).rejects.toMatchObject({
      code: 'IMAGE_CORRUPTED',
    });
  });

  it('refuse un en-tête PNG suivi de déchets', async () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    await expect(inspectImage(fake, MIN)).rejects.toMatchObject({ code: 'IMAGE_CORRUPTED' });
  });
});

describe('processToPng', () => {
  it('redimensionne proportionnellement sans jamais agrandir', async () => {
    const large = await makeStamp({ width: 2400, height: 1200 });
    const result = await processToPng(large, { maxWidth: 1200 });
    expect(result).toMatchObject({ width: 1200, height: 600 });

    const small = await makeStamp({ width: 600, height: 300 });
    expect(await processToPng(small, { maxWidth: 1200 })).toMatchObject({ width: 600, height: 300 });
  });

  it('supprime les métadonnées EXIF (version traitée et copie d’origine)', async () => {
    const withExif = await makeStamp({ format: 'jpeg', exif: true });
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const processed = await processToPng(withExif, { maxWidth: 1200 });
    expect((await sharp(processed.bytes).metadata()).exif).toBeUndefined();

    const original = await sanitizeOriginal(withExif, 'jpeg');
    expect((await sharp(original).metadata()).exif).toBeUndefined();
  });

  it('conserve la transparence d’un PNG transparent', async () => {
    const result = await processToPng(await makeStamp({ transparent: true }), { maxWidth: 1200 });
    const { data, info } = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0); // coin supérieur gauche toujours transparent
  });

  it('retire le fond blanc sans toucher à l’encre, et reste réversible depuis l’original', async () => {
    const scan = await makeStamp({ format: 'jpeg' });
    const kept = await processToPng(scan, { maxWidth: 1200, removeWhite: false });
    const removed = await processToPng(scan, { maxWidth: 1200, removeWhite: true });

    const alphaAt = async (png: Buffer, x: number, y: number) => {
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return data[(y * info.width + x) * 4 + 3]!;
    };
    expect(await alphaAt(kept.bytes, 5, 5)).toBe(255);
    expect(await alphaAt(removed.bytes, 5, 5)).toBe(0); // fond blanc devenu transparent
    expect(await alphaAt(removed.bytes, 100, 60)).toBe(255); // encre conservée
    // L'original n'est pas modifié : on peut désactiver l'option et retrouver le fond.
    expect(await alphaAt((await processToPng(scan, { maxWidth: 1200, removeWhite: false })).bytes, 5, 5)).toBe(255);
  });
});

describe('applyWhiteRemoval', () => {
  it('transparence progressive entre les seuils et pixels intacts sous le seuil bas', () => {
    const rgba = Buffer.from([
      255, 255, 255, 255, // blanc pur → transparent
      220, 220, 220, 255, // gris clair → semi-transparent
      100, 100, 100, 255, // gris foncé → intact
    ]);
    const out = applyWhiteRemoval(rgba);
    expect(out[3]).toBe(0);
    expect(out[7]).toBeGreaterThan(0);
    expect(out[7]).toBeLessThan(255);
    expect(out[11]).toBe(255);
    expect(rgba[3]).toBe(255); // entrée non mutée
  });
});

describe('toPdfEmbeddable', () => {
  it('laisse PNG et JPEG intacts', async () => {
    const png = await makeStamp({ format: 'png' });
    expect(await toPdfEmbeddable(new Uint8Array(png))).toMatchObject({ format: 'png' });
    const jpg = await makeStamp({ format: 'jpeg' });
    expect(await toPdfEmbeddable(new Uint8Array(jpg))).toMatchObject({ format: 'jpg' });
  });

  it('convertit un WebP en PNG', async () => {
    const result = await toPdfEmbeddable(new Uint8Array(await makeStamp({ format: 'webp' })));
    expect(result?.format).toBe('png');
    expect(detectImageType(Buffer.from(result!.bytes))).toBe('png');
  });

  it('rastérise un logo SVG déjà enregistré', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#0a0a78"/></svg>';
    const result = await toPdfEmbeddable(new Uint8Array(Buffer.from(svg)));
    expect(result?.format).toBe('png');
  });

  it('renvoie null (sans exception) pour un contenu illisible', async () => {
    await expect(toPdfEmbeddable(new Uint8Array(Buffer.from('pas une image')))).resolves.toBeNull();
  });
});
