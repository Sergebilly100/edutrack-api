type SecretRequirement = {
  name: string;
  minLength?: number;
  description?: string;
};

const isSmsMockEnabled = (): boolean =>
  (process.env.SMS_MOCK ?? 'false').toLowerCase() === 'true';

const REQUIRED_SECRETS_PRODUCTION: SecretRequirement[] = [
  { name: 'JWT_PRIVATE_KEY', description: 'RSA private key used to sign access/refresh tokens' },
  { name: 'JWT_PUBLIC_KEY', description: 'RSA public key used to verify tokens' },
  { name: 'DATABASE_URL', description: 'PostgreSQL connection string' },
  { name: 'REDIS_URL', description: 'Redis connection string (queues + revocation)' },
  { name: 'CORS_ORIGINS', description: 'Comma-separated list of allowed origins' },
  { name: 'SALARY_EXPORT_SIGNING_SECRET', minLength: 32, description: 'HMAC secret for signed salary download URLs' },
  // R2 : stockage des fichiers/documents (PII élèves). Sans ces secrets, le
  // module documents basculait silencieusement sur le FS éphémère (perte au
  // redeploy + hors contrôle d'accès R2). On exige donc R2 en prod.
  { name: 'R2_ACCOUNT_ID', description: 'Cloudflare R2 account id (file storage / PII)' },
  { name: 'R2_ACCESS_KEY', description: 'Cloudflare R2 access key (file storage / PII)' },
  { name: 'R2_SECRET_KEY', description: 'Cloudflare R2 secret key (file storage / PII)' },
  { name: 'R2_BUCKET', description: 'Cloudflare R2 bucket name (file storage / PII)' },
];

// Secrets du provider SMS : exigés uniquement quand l'envoi réel est activé
// (SMS_MOCK != true). En mock, aucun coût/échec silencieux. AfricasTalking est
// le provider par défaut alimenté par env (cf. notifications.service).
const REQUIRED_SECRETS_PRODUCTION_REAL_SMS: SecretRequirement[] = [
  { name: 'AFRICASTALKING_API_KEY', description: 'AfricasTalking API key (real SMS, coût réel)' },
  { name: 'AFRICASTALKING_USERNAME', description: 'AfricasTalking username (real SMS)' },
];

const REQUIRED_SECRETS_ALWAYS: SecretRequirement[] = [
  { name: 'JWT_PRIVATE_KEY' },
  { name: 'JWT_PUBLIC_KEY' },
  { name: 'DATABASE_URL' },
];

export const assertRequiredSecrets = (): void => {
  const env = process.env.NODE_ENV ?? 'development';
  const requirements =
    env === 'production'
      ? [
          ...REQUIRED_SECRETS_PRODUCTION,
          ...(isSmsMockEnabled() ? [] : REQUIRED_SECRETS_PRODUCTION_REAL_SMS),
        ]
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
