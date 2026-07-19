// @ts-nocheck — BYO reference, not compiled here. `@cloudflare/sandbox` is a
// workerd-only module this repo never installs, so an IDE opening this stray
// .ts would flag the imports below as unresolved. In your own wrangler project
// (where it IS installed), drop this line and `npx wrangler types` types `Env`.
/**
 * REFERENCE, not a runnable project. This is the ~15-line Worker you deploy
 * into *your own* Cloudflare account to reach a real Cloudflare Sandbox from
 * example 11's live segment (see README.md next to this file — bring your own
 * CF account). Copy these files into your own wrangler project; nothing here
 * is installed, typechecked, or published by this repo.
 *
 * It's the only place the real Cloudflare pieces get assembled: the protocol
 * translation itself lives in `@nimbo/sandbox-cloudflare/worker` and
 * deliberately has zero Cloudflare imports (docs/tech/sandbox.md §8.2:
 * `@cloudflare/sandbox` can only load inside workerd, so the package keeps
 * `getSandbox` injectable and this reference supplies the actual
 * `getSandbox(env.Sandbox, id)` wiring).
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
  // In your own project, `npx wrangler types` generates the precise Env type;
  // the structural shape here is what `getSandbox` actually needs.
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
