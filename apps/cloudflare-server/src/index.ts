/**
 * Worker 入口。三样东西从这里导出：HTTP 处理器、会话对象类、沙盒类——后两者是
 * Durable Object，`wrangler.jsonc` 按类名找它们。
 */
import { createApp } from './app.js';
import type { Env } from './env.js';

export { ConversationObject } from './conversation-object.js';
export { Sandbox } from '@cloudflare/sandbox';

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
