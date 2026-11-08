import { describe, expect, it } from 'vitest';

import { SafeFetchError, isPrivateAddress, safeFetchBuffer } from '../../src/shared/image/safe-fetch.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', 'pas-une-ip',
  ])('refuse %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111'])('accepte %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('safeFetchBuffer', () => {
  const options = { maxBytes: 1024 };

  it('refuse une adresse non HTTPS', async () => {
    await expect(safeFetchBuffer('http://exemple.ci/logo.png', options)).rejects.toMatchObject({ code: 'INVALID_URL' });
  });

  it('refuse une adresse invalide ou avec identifiants', async () => {
    await expect(safeFetchBuffer('pas une url', options)).rejects.toBeInstanceOf(SafeFetchError);
    await expect(safeFetchBuffer('https://user:pass@exemple.ci/a.png', options)).rejects.toMatchObject({ code: 'INVALID_URL' });
  });

  it.each([
    'https://127.0.0.1/logo.png',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/a.png',
    'https://[::1]/a.png',
  ])('refuse l’adresse interne %s', async (url) => {
    await expect(safeFetchBuffer(url, options)).rejects.toMatchObject({ code: 'FORBIDDEN_HOST' });
  });

  it('refuse un nom d’hôte qui se résout vers une adresse privée (DNS rebinding)', async () => {
    const lookup = ((_host: string, _opts: unknown, cb: (e: null, a: unknown) => void) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }])) as never;
    await expect(
      safeFetchBuffer('https://pirate.exemple.ci/logo.png', { ...options, lookup })
    ).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('refuse une plage réservée à la documentation avant toute connexion', async () => {
    await expect(safeFetchBuffer('https://192.0.2.1/a.png', { ...options, timeoutMs: 200 })).rejects.toMatchObject({
      code: 'FORBIDDEN_HOST',
    });
  });
});
