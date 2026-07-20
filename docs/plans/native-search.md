# 原生搜索（native search）· 施工进展

> 相关：[builtin-tools 技术方案](../tech/builtin-tools.md) §3.7/§3.8/§7（工具双路径自适应、已知限制）· [sandbox 技术方案](../tech/sandbox.md) §3/§4/§5.1（`NimboFS` 可选方法契约、适配器逐家映射）· [core-sdk 技术方案](../tech/core-sdk.md) §4.4（`NimboFS` 契约段落）· 术语见 [docs/terms.md](../terms.md)「原生搜索」
> 依赖：[sandbox 施工进展](./sandbox.md)（P10 三接入包；本功能只改 `@nimbo/sandbox-vercel`，不涉及 E2B/Cloudflare）

## 背景：定位结论

chat 应用的沙盒工作区是 `@nimbo/sandbox-vercel` 的远端 microVM；内置 `grep`/`glob` 工具目前是纯 JS 逐文件扫描——每次 `readdir`/`stat`/`readFile` 都是一次到沙盒的网络往返，且全部串行，还会扫进 `.git`。一次 `grep` 动辄上千次往返，实测慢几十秒到几分钟。治本方向 [tech/sandbox](../tech/sandbox.md) §4 早有预案：扫描类操作应该一条命令在沙盒内解决——本功能把这条预案落地成 `grep`/`glob` 的自适应快路径。

## 设计定案摘要（主线程拍板，2026-07-16）

1. **NimboFS 可选方法**（`packages/core/src/types.ts`）：新增 `searchFiles?(query: FileSearchQuery): Promise<FileSearchResult>` 与 `searchContent?(query: ContentSearchQuery): Promise<ContentSearchResult>`，配套 `SearchUnsupportedError`（`packages/core/src/search.ts`，独立文件以维持 `types.ts` 头注释「纯接口不含运行时实现」的纪律）。查询/结果类型全文见 [tech/sandbox](../tech/sandbox.md) §3。**`MemoryFS`/`OverlayFS`/`DirFS` 一律不实现**——`OverlayFS` 罩着远端 base 时，base 的 native 搜索看不见 overlay 层的脏写，回退到走 `glob()`（会经过 overlay 合并视图）才是正确语义。
2. **工具层双路径自适应**（`packages/virtual-fs/src/tools/{glob,grep}.ts`）：`ctx.fs.searchFiles`/`searchContent` 存在则优先调用；捕获 `SearchUnsupportedError` 静默回退现有 JS 扫描，其余错误照常经 `errorResult` 上浮。两条路径统一归一成 `FileSearchResult`/`ContentSearchResult` 中间形态，喂给同一个格式化函数，保证两种底座输出逐字符一致。`shared.ts` 新增 `DEFAULT_SEARCH_IGNORE = ["**/.git", "**/node_modules"]`（ancestor-or-self 语义，同 `DirFS.ignorePatterns`），两条路径应用同一份忽略集合；`path` 显式指向某个默认忽略目录本身或其内部时，对应默认项放行（`resolveDefaultIgnore`）。
3. **Vercel 适配器**（`packages/sandbox-vercel/src/fs.ts`）：`searchFiles`/`searchContent` 各一次 `sandbox.runCommand({ cmd: "node", args: ["-e", SCRIPT, "--", JSON.stringify(payload)] })` 完成整个搜索（argv 数组直传，无 shell 拼接/转义问题），`timeoutMs: 60_000`。glob 模式与 ignore 模式在服务端用 `globToRegExp(pattern).source` 预编译成正则 source 随 payload 传入，脚本内只 `new RegExp(source)`——两底座同一 JS 正则引擎，语义零漂移。`node` 可用性探测：首次调用失败且症状是「`node` 不存在」时抛 `SearchUnsupportedError` 并缓存判定，后续调用直接快速抛；脚本真实执行错误不缓存、照常上浮。既有 `glob()`（七方法之一）也重写为同一脚本载体的一次往返（不带 ignore、不设 limit，语义与现状完全一致），`node` 不可用时回退保留的 `walkFiles` 旧实现。
4. **工具 description**：面向模型的英文文案更新，说明默认忽略 `.git`/`node_modules`、`path` 显式指入可覆盖。

## 拆单

| # | 内容 | 归属 | 状态 |
|---|---|---|---|
| 1 | core：`NimboFS.searchFiles?`/`searchContent?` + 查询/结果类型 + `SearchUnsupportedError`，从 `@nimbo/core` 导出 | coder | ✅ 已实现（`packages/core/src/{types,search,index}.ts`，与本工单同步施工） |
| 2 | virtual-fs：`glob.ts`/`grep.ts` 双路径自适应 + `shared.ts` 默认忽略与放行规则 | coder | ✅ 已实现（`packages/virtual-fs/src/tools/{glob,grep,shared}.ts`，与本工单同步施工） |
| 3 | sandbox-vercel：`searchFiles`/`searchContent` 的 `node -e` 脚本载体 + `glob()` 重写为同一脚本载体 + node 可用性探测缓存 | coder | ✅ 已实现（`packages/sandbox-vercel/src/{fs,search-script}.ts`；含第 1 轮返工修复 `staticPrefixDir` 精确路径缺陷） |
| 4 | 测试：core/virtual-fs 双路径分支（native 成功 / 落空回退 / 忽略放行）+ sandbox-vercel fake 契约（脚本 payload 正确性、node 缺失回退、真机 e2e） | tester | ✅ 已完成（core +15、virtual-fs +34、sandbox-vercel +30；含真实 `spawn(node)` e2e 与 native/fallback 逐字符对拍） |
| 5 | 文档：术语 + tech/{builtin-tools,sandbox,core-sdk}.md 同步 + 本文件 | coder（本次） | ✅ 已完成 |

**依赖顺序**：#3（Vercel 适配器）依赖 #1/#2 已落地的接口形状（已满足，可直接开工）；#4 中 core/virtual-fs 侧用例可独立于 #3 先行，sandbox-vercel 侧用例需 #3 落地后补齐。

## 验收要点

- `glob`/`grep` 在未实现 native 方法的 FS（`MemoryFS`/`OverlayFS`/`DirFS`）上行为与改造前逐字符一致（回归护栏，两条路径共用同一中间形态与格式化函数）。
- 适配器抛 `SearchUnsupportedError` 时工具静默回退，不出现在模型可见的错误文案里；其余错误正常经 `errorResult` 上浮，不被误吞。
- 默认忽略 `.git`/`node_modules`；`path` 显式指向这两个目录本身或其内部时，对应默认项放行（允许模型明确搜进 `.git`）。
- native 路径与 JS 回退路径对同一输入产出逐字符相同的格式化输出。
- sandbox-vercel：脚本对 glob 模式、ignore 模式与内容正则均使用与本地相同的 JS 正则引擎（服务端预编译 `.source`、脚本内 `new RegExp(source)`，零字符串拼接）；`node` 不存在时首次探测失败即抛 `SearchUnsupportedError` 并缓存判定，避免每次调用重复探测；脚本真实执行错误（非 node 缺失）不缓存、照常上浮。
- 既有 `glob()` 七方法之一改走脚本后，与 `node` 不可用时的 `walkFiles` 回退语义完全一致（不带 ignore、不设 limit）。
- content 模式的 `±context` 收集、`maxFiles`/`maxLines` 双闸截断（谁先到先截）、`totalFiles` 全量计数语义与现有 JS 实现（`collectFileMatches`/`capContentSearch`）对齐；二进制嗅探（文件头 8KB 含 `NUL` 即跳过）与 `readTextOrSkip` 的判定口径一致。

## 验收结论

**第 2 轮独立验收：通过（pass-with-notes）** — 2026-07-16，orchestrator 亲自跑管线：

- typecheck：core / virtual-fs / sandbox-vercel 三包全绿。
- build：三包按依赖顺序（core → virtual-fs → sandbox-vercel）成功产出 dist。
- test：core 389/389、virtual-fs 193/193、sandbox-vercel 70/70（基线 374/159/40，用例数分别 +15/+34/+30）。

抽查结论：`grep.ts`/`glob.ts` 双路径共用同一 formatter；`fs.ts` 一次往返 + regex source 服务端预编译；`SearchUnsupportedError` 缓存语义（仅「node 缺失/exit 127」缓存，脚本真错与本地超时不缓存）经 `test/search.test.ts` 逐条锁定；`types.ts` 纯接口纪律未破坏（运行时错误类独立在 `search.ts`）；新增代码无 `any`/`as` 断言/非空断言逃逸；native-vs-fallback 逐字符对拍用独立 `readdir` 遍历实现（非自比自），并有真实 `spawn(node)` e2e 覆盖。第 1 轮返工的 `staticPrefixDir` 精确路径缺陷已修复，4 个回归用例转绿。

遗留（notes，不阻断）：① `search-script.e2e.test.ts` 里锁定该缺陷的 `describe("BUG: ...")` 块与 `FAILS today` 注释、以及三个语义用例为绕开旧缺陷改用通配符 scope 的 workaround，缺陷已修复后均已过时，建议 tester 做一次注释/命名清理（纯 hygiene，不影响正确性）。② `runCommand()` 任意拒绝（含瞬时网络抖动）都会把本 `createVercelFs()` 实例永久标记为「node 不可用」直至实例回收——按定案字面（「如 runCommand 拒绝或 127」）实现，如需收紧判据另开工单。③ 无通配符的精确文件名（如 `glob("package.json")`）现会从根做一次全树遍历（仍是单次往返、结果正确，只是失去前缀收窄优化）。

## 变更记录

| 日期 | 阶段 | 变更 | 结论 |
|---|---|---|---|
| 2026-07-16 | 设计定案（主线程） | grep/glob 原生搜索快路径：`NimboFS` 两个可选方法 + 工具层双路径自适应 + Vercel `node -e` 脚本载体 | — |
| 2026-07-16 | 文档回填（coder） | `terms.md` 新增「原生搜索」术语；`tech/{builtin-tools,sandbox,core-sdk}.md` 同步接口契约、工具行为与已知限制；新建本文件建立拆单 | 待拆单 #3/#4 完工后回填「验收结论」栏 |
| 2026-07-16 | 第 1 轮返工（coder） | 修复 `staticPrefixDir` 对无通配符精确路径把叶子文件当起始目录导致的恒空结果缺陷 | 4 个回归用例转绿 |
| 2026-07-16 | 第 2 轮独立验收（orchestrator） | 三包 typecheck/build/test 亲自跑绿（389/193/70）；抽查双路径、缓存语义、类型逃逸、对拍真实性 | 通过（pass-with-notes），遗留见「验收结论」 |
| 2026-07-16 | 线上事故修复（主线程） | chat 应用 grep 依旧十几秒：`apps/node-server` 的 `gateWorkspace`（chat-agent.ts）逐方法重建 workspace 时只转发了 `NimboFS` 七个必选方法，可选的 `searchFiles`/`searchContent` 被剥掉，原生搜索在 chat 应用里从未生效（验收范围只到 packages，未覆盖这层集成包装）。已补转发 + 2 个回归用例锁定（server 194/194 绿） | 教训：`NimboFS` 新增可选能力方法时，所有"显式逐方法转发"的包装层必须同步；`gateWorkspace` 注释已加警示 |
