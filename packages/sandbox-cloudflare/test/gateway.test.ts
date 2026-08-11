/** 网关单测：不经客户端，直接构造 Request 断言鉴权/解析/路由三条边界（docs/host/sandbox/tech.md §8.4）。 */
import { describe, expect, it } from "vitest";
import { createSandboxGateway } from "../src/worker.js";
import { errorBodySchema } from "../src/protocol.js";
import { FakeCfSandbox } from "./helpers.js";

const TOKEN = "test-token";

function makeGateway(): ReturnType<typeof createSandboxGateway> {
  return createSandboxGateway({ token: TOKEN, getSandbox: async () => new FakeCfSandbox() });
}

async function readErrorBody(res: Response) {
  const json: unknown = await res.json();
  return errorBodySchema.parse(json);
}

describe("createSandboxGateway: 鉴权/解析/路由三条边界", () => {
  it("缺少 Authorization 头 -> 401 unauthorized", async () => {
    const gateway = makeGateway();
    const res = await gateway.fetch(
      new Request("http://gw.local/fs/stat", { method: "POST", body: JSON.stringify({ path: "/" }) }),
    );
    expect(res.status).toBe(401);
    const body = await readErrorBody(res);
    expect(body.code).toBe("unauthorized");
  });

  it("Authorization 头 token 错误 -> 401 unauthorized", async () => {
    const gateway = makeGateway();
    const res = await gateway.fetch(
      new Request("http://gw.local/fs/stat", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
        body: JSON.stringify({ path: "/" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("请求体不是合法 JSON -> 400 bad_request", async () => {
    const gateway = makeGateway();
    const res = await gateway.fetch(
      new Request("http://gw.local/fs/stat", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.code).toBe("bad_request");
  });

  it("请求体是合法 JSON 但形状不对 -> 400 bad_request", async () => {
    const gateway = makeGateway();
    const res = await gateway.fetch(
      new Request("http://gw.local/fs/stat", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ notPath: 1 }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.code).toBe("bad_request");
  });

  it("未知路径 -> 404 not_found", async () => {
    const gateway = makeGateway();
    const res = await gateway.fetch(
      new Request("http://gw.local/fs/does-not-exist", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
    const body = await readErrorBody(res);
    expect(body.code).toBe("not_found");
  });

  it("getSandbox 本身失败 -> 500 sandbox_error", async () => {
    const gateway = createSandboxGateway({
      token: TOKEN,
      getSandbox: async () => {
        throw new Error("boom");
      },
    });
    const res = await gateway.fetch(
      new Request("http://gw.local/fs/stat", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ path: "/" }),
      }),
    );
    expect(res.status).toBe(500);
    const body = await readErrorBody(res);
    expect(body.code).toBe("sandbox_error");
    expect(body.message).toContain("boom");
  });

  it("FS 端点的 path 越出虚拟根 -> 400 bad_request（网关侧独立防御，不依赖客户端先校验）", async () => {
    const gateway = makeGateway();
    const res = await gateway.fetch(
      new Request("http://gw.local/fs/stat", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ path: "../../etc/passwd" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.code).toBe("bad_request");
  });

  it("/exec 的 cwd 越出虚拟根 -> 400 bad_request（网关侧独立防御，不依赖客户端先校验）", async () => {
    const gateway = makeGateway();
    const res = await gateway.fetch(
      new Request("http://gw.local/exec", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ command: "echo hi", cwd: "../../etc" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.code).toBe("bad_request");
  });
});
