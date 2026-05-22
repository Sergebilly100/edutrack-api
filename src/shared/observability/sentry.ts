import * as Sentry from '@sentry/node';

let initialized = false;

export const initSentry = (): boolean => {
  if (initialized) return true;
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    environment: process.env.NODE_ENV ?? 'development',
  });
  initialized = true;
  return true;
};

export const isSentryEnabled = (): boolean => initialized;

export const captureException = (
  error: unknown,
  context?: {
    schemaName?: string;
    userId?: string;
    tenantId?: string;
    route?: string;
    [key: string]: unknown;
  }
): void => {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (context) {
      if (context.schemaName) scope.setTag('schema', context.schemaName);
      if (context.userId) scope.setTag('userId', context.userId);
      if (context.tenantId) scope.setTag('tenantId', context.tenantId);
      if (context.route) scope.setTag('route', context.route);
      scope.setContext('request', { ...context });
    }
    Sentry.captureException(error);
  });
};
