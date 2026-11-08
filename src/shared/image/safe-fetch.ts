import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Téléchargement d'image externe protégé contre le SSRF : HTTPS uniquement, adresses
 * privées/internes refusées (vérifiées sur l'adresse réellement utilisée pour la connexion,
 * ce qui neutralise le « DNS rebinding »), aucune redirection suivie, délai court, taille plafonnée.
 */

export class SafeFetchError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_URL' | 'FORBIDDEN_HOST' | 'FETCH_FAILED' | 'FILE_TOO_LARGE'
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

const ipv4ToInt = (address: string): number =>
  address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);

const IPV4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
];

/** true si l'adresse (IPv4 ou IPv6) est privée, locale, réservée ou invalide. */
export const isPrivateAddress = (address: string): boolean => {
  const version = net.isIP(address);
  if (version === 4) {
    const value = ipv4ToInt(address);
    return IPV4_BLOCKS.some(([base, bits]) => {
      const size = 2 ** (32 - bits);
      const start = ipv4ToInt(base);
      return value >= start && value < start + size;
    });
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    const firstGroup = parseInt(lower.split(':')[0] || '0', 16);
    if ((firstGroup & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
    if ((firstGroup & 0xffc0) === 0xfe80) return true; // fe80::/10 (lien local)
    return false;
  }
  return true;
};

const guardedLookup: typeof dns.lookup = ((hostname: string, options: unknown, callback: unknown) => {
  const done = (typeof options === 'function' ? options : callback) as (
    error: NodeJS.ErrnoException | null,
    address?: string | dns.LookupAddress[],
    family?: number
  ) => void;
  const lookupOptions = typeof options === 'object' && options !== null ? (options as dns.LookupOptions) : {};
  dns.lookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
    if (error) return done(error);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address))) {
      return done(Object.assign(new Error('FORBIDDEN_HOST'), { code: 'FORBIDDEN_HOST' }));
    }
    if (lookupOptions.all) return done(null, list);
    return done(null, list[0]!.address, list[0]!.family);
  });
}) as typeof dns.lookup;

export type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes: number;
  /** Réservé au chargement de logos hérités déjà enregistrés en http. Jamais pour un nouvel import. */
  allowHttp?: boolean;
  /** Surcharge pour les tests. */
  lookup?: typeof dns.lookup;
};

export const safeFetchBuffer = async (rawUrl: string, options: SafeFetchOptions): Promise<Buffer> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('Adresse invalide.', 'INVALID_URL');
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    throw new SafeFetchError('Seules les adresses HTTPS sont acceptées.', 'INVALID_URL');
  }
  if (url.username || url.password) {
    throw new SafeFetchError('Adresse invalide.', 'INVALID_URL');
  }
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) && isPrivateAddress(literal)) {
    throw new SafeFetchError('Cette adresse n’est pas autorisée.', 'FORBIDDEN_HOST');
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  const requester = url.protocol === 'https:' ? https : http;

  return new Promise<Buffer>((resolve, reject) => {
    const request = requester.get(
      url,
      { lookup: options.lookup ?? guardedLookup, timeout: timeoutMs, headers: { Accept: 'image/*' } },
      (response) => {
        // Redirections volontairement refusées : elles contourneraient la validation de l'hôte.
        if (response.statusCode !== 200) {
          response.resume();
          reject(new SafeFetchError('Impossible de télécharger l’image.', 'FETCH_FAILED'));
          return;
        }
        const declared = Number(response.headers['content-length'] ?? 0);
        if (declared > options.maxBytes) {
          response.resume();
          reject(new SafeFetchError('Fichier trop volumineux.', 'FILE_TOO_LARGE'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBytes) {
            request.destroy();
            reject(new SafeFetchError('Fichier trop volumineux.', 'FILE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', () => reject(new SafeFetchError('Impossible de télécharger l’image.', 'FETCH_FAILED')));
      }
    );
    request.on('timeout', () => {
      request.destroy();
      reject(new SafeFetchError('Délai dépassé lors du téléchargement.', 'FETCH_FAILED'));
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'FORBIDDEN_HOST' || error.message === 'FORBIDDEN_HOST'
          ? new SafeFetchError('Cette adresse n’est pas autorisée.', 'FORBIDDEN_HOST')
          : new SafeFetchError('Impossible de télécharger l’image.', 'FETCH_FAILED')
      );
    });
  });
};
