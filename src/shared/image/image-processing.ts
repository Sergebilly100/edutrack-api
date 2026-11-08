import sharp from 'sharp';

/**
 * Traitement d'images partagé (logo, cachet et signature du chef de l'établissement).
 *
 * Règles communes : le type réel est déduit des octets (jamais de l'extension ni du
 * Content-Type déclaré), les métadonnées (EXIF, géolocalisation) sont supprimées, le
 * fichier est décodé en entier pour détecter les images corrompues. Aucun contenu
 * d'image ne doit être journalisé.
 */

export type RasterType = 'png' | 'jpeg' | 'webp';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** Garde-fou contre les « bombes de décompression » (largeur × hauteur). */
const MAX_INPUT_PIXELS = 40_000_000;
/** Taille maximale de la copie conservée du fichier d'origine. */
const ORIGINAL_MAX_WIDTH = 2400;
/** Taille maximale adaptée à l'impression du cachet-signature. */
export const SEAL_MAX_WIDTH = 1200;
export const LOGO_MAX_WIDTH = 800;

export const SEAL_MIN_WIDTH = 300;
export const SEAL_MIN_HEIGHT = 150;
export const LOGO_MIN_SIDE = 64;

/**
 * Seuils du retrait du fond blanc (min des canaux RGB) :
 * au-dessus de WHITE_FULL le pixel devient transparent, sous WHITE_NONE il est conservé,
 * entre les deux la transparence est progressive (bords du trait plus propres).
 */
export const WHITE_NONE = 200;
export const WHITE_FULL = 240;

export class ImageValidationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'INVALID_FILE_TYPE'
      | 'FILE_TOO_LARGE'
      | 'IMAGE_TOO_SMALL'
      | 'IMAGE_CORRUPTED'
  ) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

export const MIME_BY_TYPE: Record<RasterType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const EXTENSION_BY_TYPE: Record<RasterType, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

/** Détecte PNG, JPEG et WebP à partir des octets. SVG et tout autre format → null. */
export const detectImageType = (buffer: Buffer): RasterType | null => {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
};

export type InspectedImage = { type: RasterType; width: number; height: number };

/** Valide type réel, lisibilité et dimensions minimales. */
export const inspectImage = async (
  buffer: Buffer,
  minimum: { width: number; height: number }
): Promise<InspectedImage> => {
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new ImageValidationError('Fichier trop volumineux. Maximum 2 Mo.', 'FILE_TOO_LARGE');
  }
  const type = detectImageType(buffer);
  if (!type) {
    throw new ImageValidationError(
      'Format non supporté. Utilisez une image PNG, JPEG ou WebP.',
      'INVALID_FILE_TYPE'
    );
  }
  try {
    const metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
    const { width, height } = metadata;
    if (!width || !height) throw new Error('missing dimensions');
    // Décodage complet : détecte les fichiers tronqués que les seules métadonnées laissent passer.
    await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).raw().toBuffer();
    if (width < minimum.width || height < minimum.height) {
      throw new ImageValidationError(
        `Image trop petite (${width} × ${height} px). Minimum ${minimum.width} × ${minimum.height} px.`,
        'IMAGE_TOO_SMALL'
      );
    }
    return { type, width, height };
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError('Le fichier est corrompu ou illisible.', 'IMAGE_CORRUPTED');
  }
};

/** Rend transparents les pixels blancs ou presque blancs (voir WHITE_NONE / WHITE_FULL). */
export const applyWhiteRemoval = (rgba: Buffer): Buffer => {
  const output = Buffer.from(rgba);
  for (let offset = 0; offset < output.length; offset += 4) {
    const whiteness = Math.min(output[offset]!, output[offset + 1]!, output[offset + 2]!);
    if (whiteness >= WHITE_FULL) {
      output[offset + 3] = 0;
    } else if (whiteness > WHITE_NONE) {
      const factor = (WHITE_FULL - whiteness) / (WHITE_FULL - WHITE_NONE);
      output[offset + 3] = Math.round(output[offset + 3]! * factor);
    }
  }
  return output;
};

export type ProcessedImage = { bytes: Buffer; width: number; height: number };

/**
 * Version « prête à imprimer » : orientation EXIF appliquée, métadonnées supprimées,
 * redimensionnement proportionnel (jamais d'agrandissement), PNG pour conserver la transparence.
 */
export const processToPng = async (
  buffer: Buffer,
  options: { maxWidth: number; removeWhite?: boolean }
): Promise<ProcessedImage> => {
  try {
    const pipeline = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: options.maxWidth, withoutEnlargement: true });

    if (!options.removeWhite) {
      const { data, info } = await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
      return { bytes: data, width: info.width, height: info.height };
    }

    const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const cleaned = applyWhiteRemoval(data);
    const png = await sharp(cleaned, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { bytes: png, width: info.width, height: info.height };
  } catch {
    throw new ImageValidationError('Le fichier est corrompu ou illisible.', 'IMAGE_CORRUPTED');
  }
};

/** Copie du fichier d'origine, dans son format, sans métadonnées et plafonnée en taille. */
export const sanitizeOriginal = async (
  buffer: Buffer,
  type: RasterType,
  maxWidth: number = ORIGINAL_MAX_WIDTH
): Promise<Buffer> => {
  try {
    const pipeline = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true });
    if (type === 'png') return await pipeline.png({ compressionLevel: 9 }).toBuffer();
    if (type === 'jpeg') return await pipeline.jpeg({ quality: 92 }).toBuffer();
    return await pipeline.webp({ quality: 92 }).toBuffer();
  } catch {
    throw new ImageValidationError('Le fichier est corrompu ou illisible.', 'IMAGE_CORRUPTED');
  }
};

/**
 * Convertit n'importe quelle image lisible (dont WebP et SVG hérités) en octets directement
 * intégrables par pdf-lib (PNG ou JPEG). Retourne null si l'image est illisible : un logo ne
 * doit jamais faire échouer une génération de PDF.
 */
export const toPdfEmbeddable = async (
  bytes: Uint8Array
): Promise<{ bytes: Uint8Array; format: 'png' | 'jpg' } | null> => {
  const buffer = Buffer.from(bytes);
  const type = detectImageType(buffer);
  if (type === 'png') return { bytes, format: 'png' };
  if (type === 'jpeg') return { bytes, format: 'jpg' };
  try {
    // WebP, ou SVG enregistré avant l'interdiction des nouveaux SVG : rastérisation côté serveur.
    const png = await sharp(buffer, { density: 192, limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: LOGO_MAX_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer();
    return { bytes: png, format: 'png' };
  } catch {
    return null;
  }
};
