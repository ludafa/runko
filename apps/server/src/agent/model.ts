import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';

// DeepSeek direct-connect (docs/tech/chat-webapp.md §2.2 `model.ts` /
// docs/tech/sandbox.md §8.4): same "v4 pro" default tier as
// examples/12-vercel-sandbox-real-project.e2e.test.ts's
// `DEEPSEEK_DESIGN_MODEL_ID` (confirmed there via `GET
// {DEEPSEEK_API_BASE_URL}/models`), overridable with `NIMBO_MODEL`. Reads
// `process.env` lazily inside `resolveModel()` (not at module load) so
// importing this file — e.g. transitively through `src/app.ts` for
// `generate:openapi`/`typecheck` — never fails just because credentials
// aren't configured yet; the error only surfaces when a chat route actually
// needs a model.
const DEFAULT_MODEL_ID = 'deepseek-v4-pro';

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

export function resolveModel(): LanguageModel {
  const baseURL = process.env.DEEPSEEK_API_BASE_URL?.trim();
  const apiKey = process.env.DEEPSEEK_API_TOKEN?.trim();
  if (
    baseURL === undefined ||
    baseURL.length === 0 ||
    apiKey === undefined ||
    apiKey.length === 0
  ) {
    throw new ModelConfigError(
      'DEEPSEEK_API_BASE_URL and DEEPSEEK_API_TOKEN must both be set to use the chat agent (see .env.example).',
    );
  }
  const deepseek = createDeepSeek({ baseURL, apiKey });
  const modelId = process.env.NIMBO_MODEL?.trim();
  return deepseek(
    modelId === undefined || modelId.length === 0 ? DEFAULT_MODEL_ID : modelId,
  );
}
