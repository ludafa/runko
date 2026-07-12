/**
 * `@nimbo/sandbox-cloudflare` 网关协议（tech-spec 见 docs/06-sandbox-workspace-research.md
 * §8.3）：`.`（客户端）与 `./worker`（网关）两端共用同一份 zod schema——schema 是
 * wire 契约的唯一事实来源，两端各自 `parse()` 校验后再消费，任何一端改了字段形状
 * 都会在另一端的 parse() 上炸出来，而不是悄悄读到 `undefined`。
 *
 * 全部端点 `POST` + JSON body；鉴权 `Authorization: Bearer <token>`；沙盒选择
 * `x-nimbo-sandbox: <id>`（缺省 `"default"`）；二进制经 base64；错误响应统一
 * `{ code, message }` 形状（`errorBodySchema`），配对应 HTTP 状态码。
 */
import { z } from "zod";

/** 八个端点的路径常量——两端都从这里引用，避免字面量拼写不一致。 */
export const ENDPOINTS = {
  read: "/fs/read",
  write: "/fs/write",
  rm: "/fs/rm",
  mkdir: "/fs/mkdir",
  readdir: "/fs/readdir",
  stat: "/fs/stat",
  glob: "/fs/glob",
  exec: "/exec",
} as const;

export const AUTH_HEADER = "authorization";
export const SANDBOX_ID_HEADER = "x-nimbo-sandbox";
export const DEFAULT_SANDBOX_ID = "default";

// ---- /fs/read ----

export const readRequestSchema = z.object({ path: z.string() });
export type ReadRequest = z.infer<typeof readRequestSchema>;

export const readResponseSchema = z.object({ dataBase64: z.string() });
export type ReadResponse = z.infer<typeof readResponseSchema>;

// ---- /fs/write ----

export const writeRequestSchema = z.object({ path: z.string(), dataBase64: z.string() });
export type WriteRequest = z.infer<typeof writeRequestSchema>;

/** write/rm/mkdir 共用的成功响应形状。 */
export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

// ---- /fs/rm ----

export const rmRequestSchema = z.object({ path: z.string(), recursive: z.boolean().optional() });
export type RmRequest = z.infer<typeof rmRequestSchema>;

// ---- /fs/mkdir ----

export const mkdirRequestSchema = z.object({ path: z.string() });
export type MkdirRequest = z.infer<typeof mkdirRequestSchema>;

// ---- /fs/readdir ----

export const readdirRequestSchema = z.object({ path: z.string() });
export type ReaddirRequest = z.infer<typeof readdirRequestSchema>;

/** `NimboFS.FileStat.type` 的沙盒子集——沙盒工作区没有 reference 条目（§3.1），但
 * 该字面量仍保留在 wire 类型里，让客户端可以直接复用 core 的 `DirEntry`/`FileStat`
 * 类型而不必再窄化一次。 */
export const entryTypeSchema = z.enum(["file", "dir", "reference"]);
export type WireEntryType = z.infer<typeof entryTypeSchema>;

export const wireDirEntrySchema = z.object({ name: z.string(), type: entryTypeSchema });
export type WireDirEntry = z.infer<typeof wireDirEntrySchema>;

export const readdirResponseSchema = z.object({ entries: z.array(wireDirEntrySchema) });
export type ReaddirResponse = z.infer<typeof readdirResponseSchema>;

// ---- /fs/stat ----

export const statRequestSchema = z.object({ path: z.string() });
export type StatRequest = z.infer<typeof statRequestSchema>;

export const statResponseSchema = z.object({
  type: entryTypeSchema,
  size: z.number().optional(),
  mtime: z.number().optional(),
});
export type StatResponse = z.infer<typeof statResponseSchema>;

// ---- /fs/glob ----

export const globRequestSchema = z.object({ pattern: z.string() });
export type GlobRequest = z.infer<typeof globRequestSchema>;

export const globResponseSchema = z.object({ paths: z.array(z.string()) });
export type GlobResponse = z.infer<typeof globResponseSchema>;

// ---- /exec（请求体 JSON；响应体 NDJSON，逐行是下面的判别联合） ----

export const execRequestSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
});
export type ExecRequestBody = z.infer<typeof execRequestSchema>;

export const execOutputEventSchema = z.object({
  type: z.literal("output"),
  stream: z.enum(["stdout", "stderr"]),
  data: z.string(),
});
export type ExecOutputEvent = z.infer<typeof execOutputEventSchema>;

export const execExitEventSchema = z.object({
  type: z.literal("exit"),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
});
export type ExecExitEvent = z.infer<typeof execExitEventSchema>;

/** NDJSON 逐行的判别联合：N 个 output 块 + 恰好一个终块 exit。 */
export const execStreamEventSchema = z.discriminatedUnion("type", [execOutputEventSchema, execExitEventSchema]);
export type ExecStreamEvent = z.infer<typeof execStreamEventSchema>;

export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

// ---- 错误响应 ----

/**
 * `not_found`/`not_dir`/`dir_not_empty`/`sandbox_error` 是 §8.3 原文列出的 FS 错误码；
 * `unauthorized`/`bad_request` 是本工单施工时的裁量补充（鉴权失败 401、请求体
 * 解析/校验失败 400 都需要一个结构化 code，而不是把 401/400 的语义硬塞进上面四个
 * FS 专用码里）。
 */
export const errorCodeSchema = z.enum(["not_found", "not_dir", "dir_not_empty", "sandbox_error", "unauthorized", "bad_request"]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.object({ code: errorCodeSchema, message: z.string() });
export type ErrorBody = z.infer<typeof errorBodySchema>;
