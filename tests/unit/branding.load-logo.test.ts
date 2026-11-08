import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/shared/database/db.js', () => ({ db: { execute: vi.fn() } }));

import { loadLogo } from '../../src/shared/pdf/branding.js';

const toDataUri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;

describe('loadLogo (rendu PDF des logos)', () => {
  it('rend un logo WebP (auparavant ignoré silencieusement)', async () => {
    const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0a0a78' } }).webp().toBuffer();
    const result = await loadLogo(toDataUri('image/webp', webp));
    expect(result?.format).toBe('png');
  });

  it('rend un logo SVG déjà enregistré par rastérisation serveur', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="50" fill="#0a0a78"/></svg>');
    const result = await loadLogo(toDataUri('image/svg+xml', svg));
    expect(result?.format).toBe('png');
  });

  it('PNG : octets inchangés', async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
    const result = await loadLogo(toDataUri('image/png', png));
    expect(Buffer.from(result!.bytes).equals(png)).toBe(true);
  });

  it('refuse sans appel réseau une adresse interne (SSRF) et ne lève pas', async () => {
    const warn = vi.fn();
    await expect(loadLogo('https://169.254.169.254/latest/meta-data', { warn })).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('contenu illisible : null', async () => {
    await expect(loadLogo(toDataUri('image/png', Buffer.from('rien')))).resolves.toBeNull();
  });
});
