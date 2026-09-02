/**
 * 协议两端进程内对接（docs/tech/sandbox.md §8.4）：`cloudflareWorkspace()` 的 `fetch` 注入为
 * `fetchViaGateway(gateway)`，客户端 ← fake fetch ← 网关 ← `FakeCfSandbox` 全链路
 * 走真实 wire 编解码——覆盖 RunkoFS 七方法 + RunkoExec 契约、二进制往返、NDJSON
 * 跨 chunk 边界、401/404/409 错误翻译、abort 传播、timeoutMs 124。
 */
import { describe, expect, it } from "vitest";
import { DirectoryNotEmptyError, NotFoundError } from "@runko/virtual-fs";
import { cloudflareWorkspace } from "../src/index.js";
import { createSandboxGateway } from "../src/worker.js";
import type { CfExecResult, CfSandboxLike } from "../src/worker.js";
import { FakeCfSandbox, fetchViaGateway } from "./helpers.js";

const TOKEN = "test-token";
const BASE_URL = "http://gw.local";

function makeWorkspace(sandbox: FakeCfSandbox, opts: { token?: string; sandboxId?: string } = {}) {
  const gateway = createSandboxGateway({ token: TOKEN, getSandbox: async () => sandbox });
  return cloudflareWorkspace({
    url: BASE_URL,
    token: opts.token ?? TOKEN,
    sandboxId: opts.sandboxId,
    fetch: fetchViaGateway(gateway),
  });
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

describe("RunkoFS 七方法：走真实 wire 编解码", () => {
  it("writeFile → readFile 往返，二进制内容（含 0x00 字节）精确保真", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    const bytes = new Uint8Array([0, 1, 2, 3, 0, 255, 254, 0, 65, 66]);
    await ws.writeFile("/bin/data.bin", bytes);
    const read = await ws.readFile("/bin/data.bin");
    expect([...read]).toEqual([...bytes]);
  });

  it("writeFile 接受字符串内容，自动 UTF-8 编码", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await ws.writeFile("/hello.txt", "你好，世界");
    const read = await ws.readFile("/hello.txt");
    expect(new TextDecoder().decode(read)).toBe("你好，世界");
  });

  it("writeFile 自动创建父目录（mkdir -p 语义）", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await ws.writeFile("/a/b/c/deep.txt", "x");
    const entries = await ws.readdir("/a/b/c");
    expect(entries.map((e) => e.name)).toEqual(["deep.txt"]);
  });

  it("readFile 对不存在路径抛 NotFoundError", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await expect(ws.readFile("/nope.txt")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("mkdir + readdir：目录列出直接子级，name/type 正确", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await ws.mkdir("/src");
    await ws.writeFile("/src/index.ts", "export {}");
    await ws.mkdir("/src/nested");
    const entries = await ws.readdir("/src");
    const byName = new Map(entries.map((e) => [e.name, e.type]));
    expect(byName.get("index.ts")).toBe("file");
    expect(byName.get("nested")).toBe("dir");
  });

  it("readdir 根目录 \"/\"", async () => {
    const ws = makeWorkspace(new FakeCfSandbox({ files: { "top.txt": "hi" } }));
    const entries = await ws.readdir("/");
    expect(entries.map((e) => e.name)).toEqual(["top.txt"]);
  });

  it("stat：文件返回 size/mtime，目录返回 type 'dir'", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await ws.writeFile("/f.txt", "12345");
    const fileStat = await ws.stat("/f.txt");
    expect(fileStat.type).toBe("file");
    expect(fileStat.size).toBe(5);
    expect(typeof fileStat.mtime).toBe("number");

    await ws.mkdir("/d");
    const dirStat = await ws.stat("/d");
    expect(dirStat.type).toBe("dir");
  });

  it("stat 对不存在路径抛 NotFoundError", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await expect(ws.stat("/missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("stat 对父目录本身也不存在的路径同样抛 NotFoundError（findEntry 的 listFiles 失败分支）", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await expect(ws.stat("/no-such-dir/child.txt")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("writeFile 目标是已存在的目录 → 400 not_dir（网关侧 translateFsError 的目录分支）", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await ws.mkdir("/d");
    await expect(ws.writeFile("/d", "x")).rejects.toThrow(/not_dir/);
  });

  it("mkdir 目标已存在同名文件 → 500 sandbox_error（网关侧 translateFsError 的兜底分支）", async () => {
    const ws = makeWorkspace(new FakeCfSandbox({ files: { "f.txt": "x" } }));
    await expect(ws.mkdir("/f.txt")).rejects.toThrow(/sandbox_error/);
  });

  it("readdir 对不存在路径抛 NotFoundError", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await expect(ws.readdir("/missing-dir")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("readdir 目标是文件而非目录 → 400 not_dir", async () => {
    const ws = makeWorkspace(new FakeCfSandbox({ files: { "f.txt": "x" } }));
    await expect(ws.readdir("/f.txt")).rejects.toThrow(/not_dir/);
  });

  it("readdir 期间 listFiles 意外失败 → 500 sandbox_error（不同于目录不存在的 404）", async () => {
    const stub: CfSandboxLike = {
      exec: () => {
        throw new Error("not used");
      },
      readFile: () => {
        throw new Error("not used");
      },
      writeFile: () => {
        throw new Error("not used");
      },
      mkdir: async () => ({ success: true }),
      deleteFile: async () => ({ success: true }),
      listFiles: async (path) => {
        if (path === ".") {
          return { files: [{ name: "d", relativePath: "d", type: "directory", size: 0, modifiedAt: new Date().toISOString() }] };
        }
        throw new Error("listFiles failed on purpose");
      },
    };
    const gateway = createSandboxGateway({ token: TOKEN, getSandbox: async () => stub });
    const ws = cloudflareWorkspace({ url: BASE_URL, token: TOKEN, fetch: fetchViaGateway(gateway) });
    await expect(ws.readdir("/d")).rejects.toThrow(/sandbox_error/);
  });

  it("glob 期间 listFiles 失败 → 500 sandbox_error", async () => {
    const stub: CfSandboxLike = {
      exec: () => {
        throw new Error("not used");
      },
      readFile: () => {
        throw new Error("not used");
      },
      writeFile: () => {
        throw new Error("not used");
      },
      mkdir: async () => ({ success: true }),
      deleteFile: async () => ({ success: true }),
      listFiles: async () => {
        throw new Error("listFiles failed on purpose");
      },
    };
    const gateway = createSandboxGateway({ token: TOKEN, getSandbox: async () => stub });
    const ws = cloudflareWorkspace({ url: BASE_URL, token: TOKEN, fetch: fetchViaGateway(gateway) });
    await expect(ws.glob("**/*")).rejects.toThrow(/sandbox_error/);
  });

  it("rm(\"/\") 被拒绝：不允许删除虚拟根", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await expect(ws.rm("/")).rejects.toThrow(/virtual root/);
  });

  it("glob：只匹配文件、跨目录递归、按路径排序", async () => {
    const ws = makeWorkspace(
      new FakeCfSandbox({
        files: {
          "src/a.ts": "a",
          "src/nested/b.ts": "b",
          "src/c.md": "c",
        },
      }),
    );
    const matches = await ws.glob("**/*.ts");
    expect(matches).toEqual(["/src/a.ts", "/src/nested/b.ts"]);
  });

  it("rm 非递归删除空目录成功", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await ws.mkdir("/empty");
    await ws.rm("/empty");
    await expect(ws.stat("/empty")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rm 非递归删除非空目录 → DirectoryNotEmptyError（409 翻译）", async () => {
    const ws = makeWorkspace(new FakeCfSandbox({ files: { "d/f.txt": "x" } }));
    await expect(ws.rm("/d")).rejects.toBeInstanceOf(DirectoryNotEmptyError);
  });

  it("rm { recursive: true } 删除非空目录成功", async () => {
    const ws = makeWorkspace(new FakeCfSandbox({ files: { "d/f.txt": "x", "d/nested/g.txt": "y" } }));
    await ws.rm("/d", { recursive: true });
    await expect(ws.stat("/d")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rm 对不存在路径抛 NotFoundError", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    await expect(ws.rm("/nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("鉴权与传输层错误", () => {
  it("token 错误 → 网关 401，客户端抛出携带该信息的 Error", async () => {
    const ws = makeWorkspace(new FakeCfSandbox(), { token: "wrong-token" });
    await expect(ws.stat("/")).rejects.toThrow(/unauthorized/);
  });
});

describe("RunkoExec：exec() 走 NDJSON 流", () => {
  it("成功命令：onOutput 收到分片，最终 ExecResult 聚合正确", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    const chunks: { stream: string; data: string }[] = [];
    const result = await ws.exec({ command: "echo hello-world", signal: neverAbort() }, { onOutput: (c) => chunks.push(c) });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-world\n");
    expect(result.stderr).toBe("");
    expect(typeof result.durationMs).toBe("number");
    // 内置解释器把 echo 输出拆成两段分别 onOutput——验证分片确实被逐个转发。
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((c) => c.data).join("")).toBe("hello-world\n");
    expect(chunks.every((c) => c.stream === "stdout")).toBe(true);
  });

  it("非零退出码：resolve 而非 reject（P6-1）", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    const result = await ws.exec({ command: "totally-unknown-command", signal: neverAbort() });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("unrecognized command");
  });

  it("bash 重定向写入的文件对 readFile 立即可见（同源工作区）——用相对路径与文件工具的 '/' 锚点对齐", async () => {
    const ws = makeWorkspace(new FakeCfSandbox());
    const result = await ws.exec({ command: "echo -n written-by-exec > note.txt", signal: neverAbort() });
    expect(result.exitCode).toBe(0);
    const content = await ws.readFile("/note.txt");
    expect(new TextDecoder().decode(content)).toBe("written-by-exec");
  });

  it("cwd 经 normalizePath 规范化后，网关把它换算成沙盒相对路径再传给 sandbox.exec", async () => {
    let observedCwd: string | undefined;
    const sandbox = new FakeCfSandbox({
      execHandler: (_command, options) => {
        observedCwd = options.cwd;
        return { exitCode: 0, stdout: "", stderr: "", duration: 1 };
      },
    });
    const ws = makeWorkspace(sandbox);
    await ws.exec({ command: "pwd", cwd: "/sub/dir", signal: neverAbort() });
    expect(observedCwd).toBe("sub/dir");
  });

  it("timeoutMs 到期 → resolve exitCode 124", async () => {
    const sandbox = new FakeCfSandbox({
      execHandler: () => new Promise<CfExecResult>(() => {}), // 永不 resolve，模拟挂起的命令
    });
    const ws = makeWorkspace(sandbox);
    const result = await ws.exec({ command: "sleep-forever", timeoutMs: 30, signal: neverAbort() });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  it("调用方 signal abort → resolve exitCode 130，且 abort 经网关传播到 sandbox.exec 的 signal", async () => {
    let sandboxSawAbort = false;
    const sandbox = new FakeCfSandbox({
      execHandler: (_command, options) =>
        new Promise<CfExecResult>((resolve) => {
          options.signal?.addEventListener("abort", () => {
            sandboxSawAbort = true;
            resolve({ exitCode: 137, stdout: "", stderr: "killed", duration: 1 });
          });
        }),
    });
    const ws = makeWorkspace(sandbox);
    const controller = new AbortController();

    const execPromise = ws.exec({ command: "sleep-forever", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await execPromise;

    expect(result.exitCode).toBe(130);
    // 客户端已经用 raceAbort 提前 resolve，不等底层真正完成；这里额外等一下只是为了
    // 断言"abort 确实经 Request.signal 传播到了 sandbox.exec 的 signal"，不是 exec() 该等的。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sandboxSawAbort).toBe(true);
  });

  it("已预先 abort 的 signal：立即 resolve exitCode 130（不等待底层请求落定）", async () => {
    const sandbox = new FakeCfSandbox();
    const ws = makeWorkspace(sandbox);
    const controller = new AbortController();
    controller.abort();
    const result = await ws.exec({ command: "echo should-not-run", signal: controller.signal });
    expect(result.exitCode).toBe(130);
  });

  it("网关不可达（fetch 抛错）→ resolve 带指导文案的非零 ExecResult", async () => {
    const ws = cloudflareWorkspace({
      url: BASE_URL,
      token: TOKEN,
      fetch: async () => {
        throw new TypeError("network error: connection refused");
      },
    });
    const result = await ws.exec({ command: "echo hi", signal: neverAbort() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gateway");
    expect(result.stderr).toContain("connection refused");
  });

  it("/exec 请求被网关拒绝（如鉴权失败）→ resolve 带 code/message 的非零 ExecResult", async () => {
    const ws = makeWorkspace(new FakeCfSandbox(), { token: "wrong-token" });
    const result = await ws.exec({ command: "echo hi", signal: neverAbort() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unauthorized");
  });

  it("网关返回非 2xx 且 body 不是合法 JSON → resolve 时仍能兜底出一个可读的错误信息", async () => {
    const ws = cloudflareWorkspace({
      url: BASE_URL,
      token: TOKEN,
      fetch: async () => new Response("<html>502</html>", { status: 502, statusText: "Bad Gateway" }),
    });
    const result = await ws.exec({ command: "echo hi", signal: neverAbort() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("non-JSON body");
  });

  it("sandbox.exec() 本身抛错：网关把它翻译成一个 exitCode 1 的终块，客户端如实 resolve", async () => {
    const sandbox = new FakeCfSandbox({
      execHandler: () => {
        throw new Error("container crashed");
      },
    });
    const ws = makeWorkspace(sandbox);
    const result = await ws.exec({ command: "echo hi", signal: neverAbort() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sandbox exec failed");
    expect(result.stderr).toContain("container crashed");
  });
});

describe("NDJSON 增量解析：必须正确处理一行被 chunk 边界切断", () => {
  it("同一个 output 事件的 JSON 被拆成三个网络 chunk，客户端仍能正确拼回", async () => {
    const encoder = new TextEncoder();
    const line1 = `{"type":"output","stream":"stdout","da`;
    const line2 = `ta":"hello split acr`;
    const line3 = `oss chunks"}\n{"type":"exit","exitCode":0,"stdout":"hello split across chunks","stderr":"","durationMs":7}\n`;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(line1));
        controller.enqueue(encoder.encode(line2));
        controller.enqueue(encoder.encode(line3));
        controller.close();
      },
    });

    const ws = cloudflareWorkspace({
      url: BASE_URL,
      token: TOKEN,
      fetch: async () => new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    });

    const chunks: { stream: string; data: string }[] = [];
    const result = await ws.exec({ command: "irrelevant", signal: neverAbort() }, { onOutput: (c) => chunks.push(c) });

    expect(chunks).toEqual([{ stream: "stdout", data: "hello split across chunks" }]);
    expect(result).toEqual({ exitCode: 0, stdout: "hello split across chunks", stderr: "", durationMs: 7 });
  });

  it("一行不是合法 JSON（协议不应产出，但防御性丢弃而不是让整次 exec 失败）", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('not-json-at-all\n{"type":"exit","exitCode":0,"stdout":"ok","stderr":"","durationMs":1}\n'));
        controller.close();
      },
    });
    const ws = cloudflareWorkspace({
      url: BASE_URL,
      token: TOKEN,
      fetch: async () => new Response(body, { status: 200 }),
    });
    const result = await ws.exec({ command: "irrelevant", signal: neverAbort() });
    expect(result).toEqual({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });
  });

  it("响应没有 body → resolve 带说明的非零 ExecResult", async () => {
    const ws = cloudflareWorkspace({
      url: BASE_URL,
      token: TOKEN,
      fetch: async () => new Response(null, { status: 200 }),
    });
    const result = await ws.exec({ command: "irrelevant", signal: neverAbort() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no body");
  });

  it("流结束但从未出现终块 exit 事件 → resolve 带说明的非零 ExecResult", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"output","stream":"stdout","data":"partial"}\n'));
        controller.close();
      },
    });
    const ws = cloudflareWorkspace({
      url: BASE_URL,
      token: TOKEN,
      fetch: async () => new Response(body, { status: 200 }),
    });
    const result = await ws.exec({ command: "irrelevant", signal: neverAbort() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("without a final exit event");
  });
});

describe("rm 的两个防御性分支：查子级/删除本身失败时如实翻译成 500 sandbox_error", () => {
  it("目录存在但子级列表查询失败 → 当作空目录继续尝试删除；删除本身失败 → 500 sandbox_error", async () => {
    const throwingSandbox: CfSandboxLike = {
      exec: () => {
        throw new Error("not used in this test");
      },
      readFile: () => {
        throw new Error("not used in this test");
      },
      writeFile: () => {
        throw new Error("not used in this test");
      },
      mkdir: async () => ({ success: true }),
      deleteFile: async () => {
        throw new Error("delete failed on purpose");
      },
      listFiles: async (path) => {
        if (path === ".") {
          return { files: [{ name: "d", relativePath: "d", type: "directory", size: 0, modifiedAt: new Date().toISOString() }] };
        }
        throw new Error("listFiles failed on purpose");
      },
    };
    const gateway = createSandboxGateway({ token: TOKEN, getSandbox: async () => throwingSandbox });
    const ws = cloudflareWorkspace({ url: BASE_URL, token: TOKEN, fetch: fetchViaGateway(gateway) });

    await expect(ws.rm("/d")).rejects.toThrow(/sandbox_error/);
    await expect(ws.rm("/d")).rejects.toThrow(/delete failed on purpose/);
  });
});
