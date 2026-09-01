/**
 * The template spec resolvers (`src/agent/e2b-template.ts`): env wins, the
 * constants are the fallback, and a malformed number is a *loud* failure —
 * these two feed a one-shot template build, so silently falling back would
 * publish a template whose size does not match what `.env` says.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_E2B_TEMPLATE_CPU_COUNT,
  DEFAULT_E2B_TEMPLATE_MEMORY_MB,
  DEFAULT_E2B_TEMPLATE_NAME,
  resolveE2bTemplate,
  resolveE2bTemplateCpuCount,
  resolveE2bTemplateMemoryMB,
} from '../../src/agent/e2b-template.js';

const VARS = [
  'E2B_TEMPLATE',
  'E2B_TEMPLATE_MEMORY_MB',
  'E2B_TEMPLATE_CPU_COUNT',
] as const;
const ORIGINAL = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  for (const v of VARS) {
    const original = ORIGINAL[v];
    if (original === undefined) {
      delete process.env[v];
    } else {
      process.env[v] = original;
    }
  }
});

describe('e2b template spec', () => {
  it('falls back to the constants when the env vars are unset', () => {
    for (const v of VARS) {
      delete process.env[v];
    }

    expect(resolveE2bTemplate()).toBe(DEFAULT_E2B_TEMPLATE_NAME);
    expect(resolveE2bTemplateMemoryMB()).toBe(DEFAULT_E2B_TEMPLATE_MEMORY_MB);
    expect(resolveE2bTemplateCpuCount()).toBe(DEFAULT_E2B_TEMPLATE_CPU_COUNT);
  });

  it('reads all three from env', () => {
    process.env.E2B_TEMPLATE = 'nimbo-chat-fat';
    process.env.E2B_TEMPLATE_MEMORY_MB = '4096';
    process.env.E2B_TEMPLATE_CPU_COUNT = '4';

    expect(resolveE2bTemplate()).toBe('nimbo-chat-fat');
    expect(resolveE2bTemplateMemoryMB()).toBe(4096);
    expect(resolveE2bTemplateCpuCount()).toBe(4);
  });

  it('treats a blank/whitespace value as unset, and trims the name', () => {
    process.env.E2B_TEMPLATE = '  base  ';
    process.env.E2B_TEMPLATE_MEMORY_MB = '   ';

    expect(resolveE2bTemplate()).toBe('base');
    expect(resolveE2bTemplateMemoryMB()).toBe(DEFAULT_E2B_TEMPLATE_MEMORY_MB);
  });

  it.each(['4O96', '0', '-512', '1.5', 'lots'])(
    'throws on a malformed size %s instead of silently building the default',
    (bad) => {
      process.env.E2B_TEMPLATE_MEMORY_MB = bad;

      expect(() => resolveE2bTemplateMemoryMB()).toThrow(
        /E2B_TEMPLATE_MEMORY_MB/,
      );
    },
  );

  it('throws on a malformed cpu count too', () => {
    process.env.E2B_TEMPLATE_CPU_COUNT = 'two';

    expect(() => resolveE2bTemplateCpuCount()).toThrow(
      /E2B_TEMPLATE_CPU_COUNT/,
    );
  });
});
