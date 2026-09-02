/**
 * grep/glob 双路径自适应测试用的"原生底座"替身（不是 *.test.ts，vitest 不会当测试文件收集）。
 *
 * `NativeSearchFake` 包一层任意 RunkoFS（通常是 `fromMemory(...)`），把 7 个基础方法原样委托
 * 给内层，`searchFiles`/`searchContent` 则**不**复用 grep.ts/glob.ts 里的 `fallbackSearchFiles`/
 * `fallbackSearchContent`（那样对拍就是同一份代码跟自己比，测不出工具层传参错误）——改用
 * `readdir()` 递归遍历取代 `glob()` 作为候选集来源，独立算出结果，只在"按文档约定的输出契约"
 * （`FileSearchQuery`/`ContentSearchQuery` 在 `@runko/core` types.ts 的字段注释）这一层与
 * grep.ts/glob.ts 保持一致——这是任何合规的原生实现都必须满足的契约，不是抄实现细节。
 *
 * 同时记录每次调用收到的 query，供测试断言"工具确实把 scope/ignore/limit/maxFiles/maxLines
 * 等参数正确传下去了"。
 */
import type {
  ContentSearchGroup,
  ContentSearchLine,
  ContentSearchQuery,
  ContentSearchResult,
  DirEntry,
  FileSearchQuery,
  FileSearchResult,
  FileStat,
  RunkoFS,
} from "@runko/core";
import { globToRegExp, isIgnoredPath } from "../../src/path.js";
import { isTextMimeType } from "../../src/tools/shared.js";

/** ±context 行收集——按 `ContentSearchLine` 文档契约（match 标记命中行 vs 周边行）独立实现。 */
function collectContextLines(text: string, regex: RegExp, context: number): ContentSearchLine[] | undefined {
  const lines = text.length === 0 ? [] : text.split("\n");
  const matchedIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i] ?? "")) {matchedIdx.push(i);}
  }
  if (matchedIdx.length === 0) {return undefined;}

  const included = new Set<number>();
  for (const idx of matchedIdx) {
    const from = Math.max(0, idx - context);
    const to = Math.min(lines.length - 1, idx + context);
    for (let j = from; j <= to; j++) {included.add(j);}
  }
  const matchedSet = new Set(matchedIdx);
  return [...included].sort((a, b) => a - b).map((i) => ({ line: i + 1, text: lines[i] ?? "", match: matchedSet.has(i) }));
}

/** maxFiles/maxLines 双闸——按 `ContentSearchResult.totalFiles`/`lineCapped` 的文档契约独立实现。 */
function capResult(groups: ContentSearchGroup[], maxFiles: number, maxLines: number, mode: "files" | "content"): ContentSearchResult {
  const totalFiles = groups.length;
  const cappedGroups = groups.length > maxFiles ? groups.slice(0, maxFiles) : groups;
  if (mode === "files") {return { groups: cappedGroups, totalFiles, lineCapped: false };}

  const boundedGroups: ContentSearchGroup[] = [];
  let consumed = 0;
  let lineCapped = false;
  for (const group of cappedGroups) {
    if (consumed >= maxLines) {
      lineCapped = true;
      break;
    }
    const remaining = maxLines - consumed;
    if (group.lines.length <= remaining) {
      boundedGroups.push(group);
      consumed += group.lines.length;
    } else {
      boundedGroups.push({ path: group.path, lines: group.lines.slice(0, remaining) });
      consumed += remaining;
      lineCapped = true;
      break;
    }
  }
  return { groups: boundedGroups, totalFiles, lineCapped };
}

export class NativeSearchFake implements RunkoFS {
  readonly fileSearchCalls: FileSearchQuery[] = [];
  readonly contentSearchCalls: ContentSearchQuery[] = [];

  constructor(private readonly inner: RunkoFS) {}

  readFile(path: string): Promise<Uint8Array> {
    return this.inner.readFile(path);
  }
  writeFile(path: string, data: Uint8Array | string): Promise<void> {
    return this.inner.writeFile(path, data);
  }
  rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.inner.rm(path, opts);
  }
  mkdir(path: string): Promise<void> {
    return this.inner.mkdir(path);
  }
  readdir(path: string): Promise<DirEntry[]> {
    return this.inner.readdir(path);
  }
  stat(path: string): Promise<FileStat> {
    return this.inner.stat(path);
  }
  glob(pattern: string): Promise<string[]> {
    return this.inner.glob(pattern);
  }

  /** 候选集来源：`readdir()` 递归遍历——刻意不用 `glob()`，与 fallback 路径的候选集来源不同。 */
  private async listAllFiles(): Promise<string[]> {
    const results: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await this.inner.readdir(dir);
      for (const entry of entries) {
        const childPath = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
        if (entry.type === "dir") {await walk(childPath);}
        else if (entry.type === "file") {results.push(childPath);}
      }
    };
    await walk("/");
    return results;
  }

  async searchFiles(query: FileSearchQuery): Promise<FileSearchResult> {
    this.fileSearchCalls.push(query);
    const patternRe = globToRegExp(query.pattern);
    const ignoreRes = (query.ignore ?? []).map(globToRegExp);
    const all = await this.listAllFiles();
    const matched = all.filter((p) => patternRe.test(p) && !isIgnoredPath(p, ignoreRes)).sort();
    return { paths: matched.slice(0, query.limit), total: matched.length };
  }

  async searchContent(query: ContentSearchQuery): Promise<ContentSearchResult> {
    this.contentSearchCalls.push(query);
    const scopeRe = globToRegExp(query.scope);
    const ignoreRes = (query.ignore ?? []).map(globToRegExp);
    const contentRe = new RegExp(query.pattern, query.ignoreCase ? "i" : "");
    const all = await this.listAllFiles();
    const candidates = all.filter((p) => scopeRe.test(p) && !isIgnoredPath(p, ignoreRes)).sort();

    const groups: ContentSearchGroup[] = [];
    for (const path of candidates) {
      const stat = await this.inner.stat(path);
      if (stat.type !== "file" || !isTextMimeType(stat.mimeType)) {continue;}
      let text: string;
      try {
        text = new TextDecoder().decode(await this.inner.readFile(path));
      } catch {
        continue;
      }
      if (query.mode === "files") {
        if (contentRe.test(text)) {groups.push({ path, lines: [] });}
      } else {
        const lines = collectContextLines(text, contentRe, query.context ?? 0);
        if (lines !== undefined) {groups.push({ path, lines });}
      }
    }
    return capResult(groups, query.maxFiles, query.maxLines, query.mode);
  }
}

/** searchFiles/searchContent 都抛同一个错误的替身——用来测 `SearchUnsupportedError` 静默回退，或普通 Error 走 errorResult 通道。 */
export class ThrowingSearchFake implements RunkoFS {
  constructor(
    private readonly inner: RunkoFS,
    private readonly error: Error,
  ) {}

  readFile(path: string): Promise<Uint8Array> {
    return this.inner.readFile(path);
  }
  writeFile(path: string, data: Uint8Array | string): Promise<void> {
    return this.inner.writeFile(path, data);
  }
  rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.inner.rm(path, opts);
  }
  mkdir(path: string): Promise<void> {
    return this.inner.mkdir(path);
  }
  readdir(path: string): Promise<DirEntry[]> {
    return this.inner.readdir(path);
  }
  stat(path: string): Promise<FileStat> {
    return this.inner.stat(path);
  }
  glob(pattern: string): Promise<string[]> {
    return this.inner.glob(pattern);
  }

  searchFiles(): Promise<FileSearchResult> {
    return Promise.reject(this.error);
  }
  searchContent(): Promise<ContentSearchResult> {
    return Promise.reject(this.error);
  }
}
