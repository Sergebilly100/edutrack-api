import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Shared Cloudflare R2 helpers.
 *
 * - `uploadToR2` keeps its legacy signature: returns a public CDN URL built from R2_PUBLIC_URL
 *   (used by logo upload).
 * - `uploadBuffer` is a lower-level helper that just writes the object and returns the key
 *   (used by salary PDF export — downloads always go through presigned URLs, no public URL needed).
 * - `presignDownload` returns a short-lived signed URL the client can fetch directly.
 * - `isR2Configured` is the gate that callers use to decide between R2 and local-fs.
 *
 * R2 env vars (sourced from Railway secrets in prod):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET, R2_PUBLIC_URL (logo only)
 */

let _client: S3Client | null = null;

const getR2Client = (): S3Client => {
  if (_client) return _client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY;
  const secretAccessKey = process.env.R2_SECRET_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials missing (R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY)');
  }

  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _client;
};

const BUCKET = process.env.R2_BUCKET ?? 'edutrack-files';
const PUBLIC_URL_BASE = process.env.R2_PUBLIC_URL?.replace(/\/$/, '');

export const isR2Configured = (): boolean => {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY &&
      process.env.R2_SECRET_KEY &&
      process.env.R2_BUCKET
  );
};

export type UploadResult = {
  url: string;
  key: string;
};

/**
 * Uploads a file buffer to R2 and returns a public URL.
 * Throws if R2_PUBLIC_URL is not configured — use `uploadBuffer` for private exports.
 */
export const uploadToR2 = async (
  key: string,
  body: Buffer,
  contentType: string
): Promise<UploadResult> => {
  const client = getR2Client();

  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  if (!PUBLIC_URL_BASE) {
    throw new Error('R2_PUBLIC_URL environment variable is required to build the public URL');
  }

  const url = `${PUBLIC_URL_BASE}/${key}`;
  return { url, key };
};

/**
 * Lower-level upload — returns the object key. Use with `presignDownload` to deliver the file.
 */
export const uploadBuffer = async (
  key: string,
  body: Buffer,
  contentType: string
): Promise<{ key: string }> => {
  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return { key };
};

/**
 * Returns a short-lived signed URL the client can use to download the object directly from R2.
 */
export const presignDownload = async (
  key: string,
  expiresInSeconds: number,
  options?: { filename?: string; contentType?: string }
): Promise<string> => {
  const client = getR2Client();
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ...(options?.filename
      ? {
          ResponseContentDisposition: `attachment; filename="${options.filename.replace(/"/g, '')}"`,
        }
      : {}),
    ...(options?.contentType ? { ResponseContentType: options.contentType } : {}),
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
};

export const deleteFromR2 = async (key: string): Promise<void> => {
  const client = getR2Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
};
