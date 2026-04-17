import { createSign, createVerify } from 'node:crypto';

type JwtValue = string | number | boolean | null | JwtValue[] | { [key: string]: JwtValue };

export type JwtPayload = {
  [key: string]: JwtValue | undefined;
  sub?: string;
  iat?: number;
  exp?: number;
};

export class JWTExpired extends Error {
  constructor() {
    super('JWT expired');
    this.name = 'JWTExpired';
  }
}

const normalizePem = (value: string): string => {
  const trimmed = value.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;

  return unquoted.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
};

const encodeBase64Url = (input: string | Buffer): string => {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buffer.toString('base64url');
};

const decodeBase64Url = (input: string): Buffer => Buffer.from(input, 'base64url');

const parseExpiryToSeconds = (value: string): number => {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  const match = trimmed.match(/^(\d+)([smhd])$/i);
  if (!match) {
    throw new Error(`Invalid JWT expiry format: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;

  return amount * multiplier;
};

export const signJwtRs256 = (params: {
  payload: JwtPayload;
  privateKeyPem: string;
  expiresIn: string;
}): string => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresInSeconds = parseExpiryToSeconds(params.expiresIn);
  const payload: JwtPayload = {
    ...params.payload,
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
  };

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  } as const;

  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(normalizePem(params.privateKeyPem));

  return `${signingInput}.${encodeBase64Url(signature)}`;
};

export const verifyJwtRs256 = (params: {
  token: string;
  publicKeyPem: string;
}): JwtPayload => {
  const parts = params.token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();

  const isValid = verifier.verify(
    normalizePem(params.publicKeyPem),
    decodeBase64Url(encodedSignature)
  );

  if (!isValid) {
    throw new Error('Invalid JWT signature');
  }

  const header = JSON.parse(decodeBase64Url(encodedHeader).toString('utf8')) as {
    alg?: string;
  };

  if (header.alg !== 'RS256') {
    throw new Error('Invalid JWT algorithm');
  }

  const payload = JSON.parse(decodeBase64Url(encodedPayload).toString('utf8')) as JwtPayload;
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp === 'number' && now >= payload.exp) {
    throw new JWTExpired();
  }

  return payload;
};
