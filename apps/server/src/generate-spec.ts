import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OpenAPIHono } from '@hono/zod-openapi';
import { stringify } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function generateOpenAPISpec(app: OpenAPIHono) {
  const spec = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'Hono Mono Starter API', version: '1.0.0' },
  });
  const outPath = resolve(__dirname, '..', 'openapi.yml');
  writeFileSync(outPath, stringify(spec), 'utf-8');
  console.log(`OpenAPI spec written to ${outPath}`);
}
