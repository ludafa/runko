import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';

import { createDemoModel } from './demo-model.js';

// DeepSeek direct-connect (docs/ingress/tech/chat-webapp.md §2.2 `model.ts` /
// docs/host/contract/tech/sandbox.md §8.4): same "v4 pro" default tier as
// examples/src/12-vercel-sandbox-real-project.ts's
// `DEEPSEEK_DESIGN_MODEL_ID` (confirmed there via `GET
// {DEEPSEEK_API_BASE_URL}/models`), overridable with `RUNKO_MODEL`. Reads
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

/** 配没配真模型。前端据此在会话页上标「演示模型」（`GET /api/chat/config`）。 */
export function hasRealModel(env: NodeJS.ProcessEnv = process.env): boolean {
  const baseURL = env.DEEPSEEK_API_BASE_URL?.trim();
  const apiKey = env.DEEPSEEK_API_TOKEN?.trim();
  return (
    baseURL !== undefined &&
    baseURL.length > 0 &&
    apiKey !== undefined &&
    apiKey.length > 0
  );
}

/**
 * 这一轮用哪个模型。**没配 key 就用[演示模型](../../../../docs/terms.md)**，不抛错——
 * 零配置跑起来是这个应用的第一条承诺，没有 key 时最该发生的事是「能用，只是不聪明」。
 */
export function resolveModel(): LanguageModel {
  if (!hasRealModel()) {
    return createDemoModel();
  }
  const baseURL = process.env.DEEPSEEK_API_BASE_URL?.trim();
  const apiKey = process.env.DEEPSEEK_API_TOKEN?.trim();
  if (
    baseURL === undefined ||
    baseURL.length === 0 ||
    apiKey === undefined ||
    apiKey.length === 0
  ) {
    throw new ModelConfigError(
      'DEEPSEEK_API_BASE_URL and DEEPSEEK_API_TOKEN must both be set to use the chat agent (see .env.template).',
    );
  }
  const deepseek = createDeepSeek({ baseURL, apiKey });
  const modelId = process.env.RUNKO_MODEL?.trim();
  return deepseek(
    modelId === undefined || modelId.length === 0 ? DEFAULT_MODEL_ID : modelId,
  );
}
