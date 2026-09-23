import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApiDocument } from './document.js';

const target = resolve(import.meta.dirname, '../../../../docs/api/openapi.json');
const version = process.env.APP_VERSION ?? '0.0.0-dev';
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(version), null, 2)}\n`);
process.stdout.write(`OpenAPI document written to ${target}\n`);
