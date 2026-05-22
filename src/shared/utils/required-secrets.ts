type SecretRequirement = {
  name: string;
  minLength?: number;
  description?: string;
};

const REQUIRED_SECRETS_PRODUCTION: SecretRequirement[] = [
  { name: 'JWT_PRIVATE_KEY', description: 'RSA private key used to sign access/refresh tokens' },
  { name: 'JWT_PUBLIC_KEY', description: 'RSA public key used to verify tokens' },
  { name: 'DATABASE_URL', description: 'PostgreSQL connection string' },
  { name: 'REDIS_URL', description: 'Redis connection string (queues + revocation)' },
  { name: 'CORS_ORIGINS', description: 'Comma-separated list of allowed origins' },
  { name: 'SALARY_EXPORT_SIGNING_SECRET', minLength: 32, description: 'HMAC secret for signed salary download URLs' },
];

const REQUIRED_SECRETS_ALWAYS: SecretRequirement[] = [
  { name: 'JWT_PRIVATE_KEY' },
  { name: 'JWT_PUBLIC_KEY' },
  { name: 'DATABASE_URL' },
];

export const assertRequiredSecrets = (): void => {
  const env = process.env.NODE_ENV ?? 'development';
  const requirements = env === 'production'
    ? REQUIRED_SECRETS_PRODUCTION
    : REQUIRED_SECRETS_ALWAYS;

  const missing: string[] = [];
  const tooShort: string[] = [];

  for (const req of requirements) {
    const value = process.env[req.name]?.trim();
    if (!value) {
      missing.push(`${req.name}${req.description ? ` (${req.description})` : ''}`);
      continue;
    }
    if (req.minLength && value.length < req.minLength) {
      tooShort.push(`${req.name} must be at least ${req.minLength} chars long (current: ${value.length})`);
    }
  }

  if (missing.length > 0 || tooShort.length > 0) {
    const lines: string[] = ['Required secrets are missing or invalid:'];
    if (missing.length > 0) {
      lines.push('Missing:');
      missing.forEach((m) => lines.push(`  - ${m}`));
    }
    if (tooShort.length > 0) {
      lines.push('Invalid:');
      tooShort.forEach((m) => lines.push(`  - ${m}`));
    }
    throw new Error(lines.join('\n'));
  }
};
