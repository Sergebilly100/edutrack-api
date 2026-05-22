import pino from 'pino';

/**
 * Logger applicatif partagé.
 *
 * Utilisé par les workers, queues et modules qui ne disposent pas d'un
 * `request.log` Fastify. Pour les handlers HTTP, préférer `request.log`
 * afin de bénéficier de la corrélation request_id / tenant_id.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'edutrack-api' },
});
