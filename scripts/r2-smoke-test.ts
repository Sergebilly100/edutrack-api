/**
 * P2-04 smoke test - validates R2 credentials end-to-end without touching billing.
 *
 * 1. Upload a 64-byte buffer to a throwaway key under `smoke-tests/`
 * 2. Generate a 60-second presigned URL
 * 3. Fetch the URL and compare bytes
 * 4. Delete the object
 *
 * Run with:  npx tsx scripts/r2-smoke-test.ts
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';

import {
  deleteFromR2,
  isR2Configured,
  presignDownload,
  uploadBuffer,
} from '../src/shared/storage/r2.js';

const main = async (): Promise<void> => {
  if (!isR2Configured()) {
    console.error('✗ R2 not configured. Check R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET in .env');
    process.exit(1);
  }

  // Show which account/bucket we are about to hit, without leaking credentials
  console.log(`→ R2 account ${process.env.R2_ACCOUNT_ID}, bucket "${process.env.R2_BUCKET}"`);

  const payload = randomBytes(64);
  const key = `smoke-tests/${Date.now()}-${randomBytes(4).toString('hex')}.bin`;

  console.log(`→ uploading ${payload.length} bytes to ${key}`);
  await uploadBuffer(key, payload, 'application/octet-stream');
  console.log('  ✓ upload ok');

  console.log('→ generating presigned URL (60s)');
  const url = await presignDownload(key, 60);
  console.log(`  ✓ presigned (${url.split('?')[0]}?...)`);

  console.log('→ fetching back via presigned URL');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch failed: HTTP ${response.status} ${await response.text()}`);
  }
  const fetched = Buffer.from(await response.arrayBuffer());
  if (!fetched.equals(payload)) {
    throw new Error(`payload mismatch: sent ${payload.length}B, got ${fetched.length}B`);
  }
  console.log('  ✓ bytes match');

  console.log('→ cleanup: deleting object');
  await deleteFromR2(key);
  console.log('  ✓ deleted');

  console.log('\n✓ P2-04 smoke test passed - R2 is wired correctly');
};

main().catch((error) => {
  console.error('\n✗ R2 smoke test FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
