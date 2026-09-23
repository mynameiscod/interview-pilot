import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { LivenessResponse, ReadinessResponse } from '@cbi/shared-types';

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

/**
 * The OpenAPI document is generated from the same Zod schemas the API and the
 * web apps use, so documentation cannot drift from the contract. Each module
 * registers its paths here as it is implemented; /api/v1 routes reference the
 * shared `ApiErrorBody` schema for their error responses.
 *
 * Only `registerPath` is used: `registry.register()` relies on a prototype
 * patch that the CommonJS build of zod-to-openapi cannot apply to ESM zod.
 */
export function buildOpenApiDocument(version: string): OpenApiDocument {
  const registry = new OpenAPIRegistry();

  registry.registerPath({
    method: 'get',
    path: '/healthz',
    tags: ['Operations'],
    summary: 'Liveness probe',
    responses: {
      200: {
        description: 'Process is running',
        content: { 'application/json': { schema: LivenessResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/readyz',
    tags: ['Operations'],
    summary: 'Readiness probe (MongoDB, Redis, draining state)',
    responses: {
      200: {
        description: 'Ready to receive traffic',
        content: { 'application/json': { schema: ReadinessResponse } },
      },
      503: {
        description: 'Not ready; a dependency is down or the process is draining',
        content: { 'application/json': { schema: ReadinessResponse } },
      },
    },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'CareerPilot Interview API',
      version,
      description:
        'REST API for CareerPilot Interview by CodeBegun. Versioned business endpoints live under /api/v1.',
    },
    servers: [{ url: 'https://api.interview.codebegun.com' }],
  });
}
