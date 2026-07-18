/**
 * nimbo sandbox gateway — the only place where the real Cloudflare pieces
 * are assembled. The protocol translation itself lives in
 * `@nimbo/sandbox-cloudflare/worker` and deliberately has zero Cloudflare
 * imports (docs/tech/sandbox.md §8.2: `@cloudflare/sandbox` can only load inside workerd,
 * so the package keeps `getSandbox` injectable and this template provides
 * the actual `getSandbox(env.Sandbox, id)` wiring).
 *
 * Deploy (see README.md next to this file):
 *   npx wrangler secret put NIMBO_GATEWAY_TOKEN   # choose a strong secret
 *   npx wrangler deploy
 *
 * Then point the client at it from any Node.js machine:
 *   cloudflareWorkspace({ url: "https://…workers.dev", token: "<the secret>" })
 */
import { getSandbox } from "@cloudflare/sandbox";
import { createSandboxGateway } from "@nimbo/sandbox-cloudflare/worker";

// The Sandbox Durable Object class must be exported from the Worker entry
// module so the `durable_objects` binding in wrangler.jsonc can find it.
export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  // Populated by `npm run cf-typegen` with the precise generated type; the
  // structural shape here is what `getSandbox` actually needs.
  Sandbox: Parameters<typeof getSandbox>[0];
  NIMBO_GATEWAY_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const gateway = createSandboxGateway({
      token: env.NIMBO_GATEWAY_TOKEN,
      getSandbox: (sandboxId) => getSandbox(env.Sandbox, sandboxId),
    });
    return gateway.fetch(request);
  },
};
