import { defineConfig } from '@kubb/core';
import { pluginClient } from '@kubb/plugin-client';
import { pluginOas } from '@kubb/plugin-oas';
import { pluginTs } from '@kubb/plugin-ts';
import { pluginZod } from '@kubb/plugin-zod';

export default defineConfig({
  input: {
    path: '../server/openapi.yml',
  },
  output: {
    path: './src/gen',
    clean: true,
  },
  plugins: [
    pluginOas(),
    pluginTs({
      output: { path: 'types' },
    }),
    pluginClient({
      output: { path: 'clients' },
      client: 'fetch',
    }),
    pluginZod({
      output: { path: 'zod' },
    }),
  ],
});
