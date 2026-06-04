/**
 * Configs de rate-limit réutilisables pour les routes sensibles.
 *
 * Le rate-limit global est désactivé (`global: false` dans server.ts) : seules
 * les routes qui déclarent explicitement `config.rateLimit` sont protégées.
 * Ce module centralise les budgets pour éviter de dupliquer le parsing d'env
 * dans chaque controller.
 */

const isProduction = process.env.NODE_ENV === 'production';

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Routes d'authentification sensibles au brute-force (change-password) hors du
 * module auth. Aligné sur le budget login (`AUTH_LOGIN_RATE_LIMIT_*`).
 */
export const AUTH_BRUTEFORCE_RATE_LIMIT = {
  max: parsePositiveInt(
    process.env.AUTH_LOGIN_RATE_LIMIT_MAX,
    isProduction ? 10 : 200
  ),
  timeWindow: process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW ?? '1 minute',
} as const;

/**
 * Routes qui mettent un SMS en queue (coût réel AfricasTalking/Orange) ou
 * déclenchent une opération lourde (import confirm). Budget volontairement bas
 * en prod pour limiter l'abus / l'explosion de coût.
 */
export const SENSITIVE_ACTION_RATE_LIMIT = {
  max: parsePositiveInt(
    process.env.SENSITIVE_ACTION_RATE_LIMIT_MAX,
    isProduction ? 20 : 200
  ),
  timeWindow: process.env.SENSITIVE_ACTION_RATE_LIMIT_WINDOW ?? '1 minute',
} as const;
