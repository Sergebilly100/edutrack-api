import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const getR2Client = (): S3Client => {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY;
  const secretAccessKey = process.env.R2_SECRET_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials missing (R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY)');
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
};

const BUCKET = process.env.R2_BUCKET ?? 'edutrack-files';
const PUBLIC_URL_BASE = process.env.R2_PUBLIC_URL?.replace(/\/$/, '');

export type UploadResult = {
  url: string;
  key: string;
};

/**
 * Uploads a file buffer to Cloudflare R2 and returns the public URL.
 * The public URL is built from R2_PUBLIC_URL env var (CDN / r2.dev domain).
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
