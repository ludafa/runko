// `env` 的类型：test/wrangler.jsonc 里那两个 Durable Object 绑定。
declare namespace Cloudflare {
  interface Env {
    BARE: DurableObjectNamespace<import("./worker.js").BareObject>;
    AGENT: DurableObjectNamespace<import("./worker.js").AgentObject>;
  }
}
