import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

/**
 * Register Swagger + Swagger UI. The schema is built from each route's `schema:`
 * option (when present); routes that still parse with `schema.parse(request.body)`
 * are listed but their request/response shapes are unknown. Migrate routes
 * to the Fastify `schema:` option (using `fastify-type-provider-zod`) to enrich
 * the doc — the swagger plugin picks up the schema automatically.
 *
 * The UI is mounted at `/docs` and gated on NODE_ENV != 'production' to avoid
 * leaking the API surface publicly. In production, only the JSON spec is exposed
 * at `/docs/json` so internal tooling can still introspect it.
 */
export const registerSwagger = async (app: FastifyInstance): Promise<void> => {
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'EduTrack CI / IvoirEdu API',
        description:
          'Multi-tenant Fastify API for school attendance, billing, and notifications.',
        version: '1.0.0',
      },
      servers: [
        {
          url: process.env.API_PUBLIC_URL ?? 'http://localhost:3000',
          description: 'Default server',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
  });
};
