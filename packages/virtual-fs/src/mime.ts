/**
 * mime 类型推断（docs/core/core-sdk/tech.md §4.4："v1 类型推断仅按扩展名；magic-bytes 嗅探...列 v2"）。
 * MemoryFS/OverlayFS/DirFS 的 stat()/readdir() 在实现未显式指定 mimeType 时兜底调用。
 */

const EXTENSION_MIME_TABLE: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonl: "application/jsonl",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "application/typescript",
  tsx: "text/tsx",
  jsx: "text/jsx",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  ini: "text/plain",
  log: "text/plain",
  sh: "application/x-sh",
  bash: "application/x-sh",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  sql: "application/sql",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/vnd.microsoft.icon",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  wasm: "application/wasm",
  apk: "application/vnd.android.package-archive",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
};

export const DEFAULT_MIME_TYPE = "application/octet-stream";

/** dotfile（如 `.gitignore`，没有"扩展名"意义上的后缀）与无扩展名文件都落入默认兜底。 */
export function inferMimeType(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0) return DEFAULT_MIME_TYPE;
  const ext = base.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_MIME_TABLE[ext] ?? DEFAULT_MIME_TYPE;
}
