---
title: "core-sdk（施工进展）"
slug: core-sdk
view: 施工
layer: 逻辑层
module: 执行引擎
packages: ["@runko/sdk", "@runko/core"]
tags: ["SDK", "agent loop", "定义层", "运行层", "VirtualFS", "skills"]
related: ["logic/engine/features/core-sdk.md", "logic/engine/tech/core-sdk.md", "architecture/tech/agent-kernel.md"]
---
# core-sdk（施工进展）

> 相关：[产品/使用手册](../features/core-sdk.md) · [技术方案](../tech/core-sdk.md)
> 依赖：[builtin-tools](../tech/builtin-tools.md)（内置工具面）· [sandbox](../../../host/contract/plans/sandbox.md)（执行环境接入包）
> 延续/演进：本页只覆盖 core-sdk 本体的施工（**P0–P8 v1 / P9 v1.1**）。后续阶段 P10（三沙盒接入包）归 [sandbox](../../../host/contract/plans/sandbox.md)、P11（真实项目 e2e 示例）与 P12（chat webapp）归 [chat-webapp](../../../ingress/plans/chat-webapp.md)、P13-5（UIMessage 单账本 + 三值审批 + 工具改名，深改 core）归 [single-ledger](../../orchestration/plans/single-ledger.md)——它们的详细拆单/验收在各自功能的施工文档，本页只保留跨功能共享的**完整变更记录**（末尾表）并在相应处交叉链接。

> 状态：**v1（P0–P8）与 v1.1（P9 全语法档 bash）全部完成**（2026-07-10 创建并改版为 pnpm monorepo 方案；2026-07-11 全阶段验收通过，[产品/使用手册](../features/core-sdk.md) §6 成功标准全部达成；唯一挂起项：npm 裸名 `runko` 发布决策）
>
> 规则：每完成一个阶段，回到本文档更新状态（✅/⏳/❌）、记录实际改动与偏差。
> 施工方式：由 `orchitector` sub agent 拆解工单与验收，`coder` sub agent 实现（见 `.claude/agents/`）。

## 仓库形态：pnpm monorepo

| 包 | 职责 | 依赖 |
|---|---|---|
| `@runko/core` | L0 接口（`RunkoFS`/`RunkoExec`/`Tool`/`ApprovalPolicy`）、L1 定义层（`defineAgent`/`defineTool`/`defineSkill`）、L2 运行层（`createSession`/loop/事件/审批链/readState）、AI SDK step runner、skills、`load-skill`/`update-plan`/`bash` 工具本体 | `ai`(peer)、`zod` |
| `@runko/virtual-fs` | `MemoryFS`/`OverlayFS`/`DirFS`、mime 推断、diff/writeBack、reference 条目；**文件工具八件套**（read/write/edit/delete/move/list-dir/glob/grep） | `@runko/core` |
| `@runko/mini-bash` | `RunkoExec` 实现：**纯 TS 解释器**（非子进程），只支持 `cat`/`grep`/`find`/`tail`/`head`/`echo`（+ P6-3/P6-4 的操作符与 cd/pwd），直接运行在任意 `RunkoFS` 上——模式 A 同源工作区的纯内存实证；全只读命令，`defaultApproval: "allow"`，`describe()` 声明命令清单 | `@runko/core` |
| `@runko/sdk` | **主包（门面）**：re-export core + virtual-fs（+ mini-bash），batteries-included，5 行上手只装这一个 | 上述三包 |
| `@runko/just-bash` | `RunkoExec` 全语法档实现（v1.1，P9）：vercel-labs/just-bash 适配器；**不进 sdk 依赖** | `@runko/core` + `just-bash` |

> 拆出 `@runko/core` 的原因：文件工具需要 core 的 `Tool`/`ToolContext` 类型，而主包默认体验需要文件工具——三包方案会在 `@runko/sdk` ↔ tool 包之间成环；core 承载接口后依赖全部单向：sdk → {core, virtual-fs, mini-bash}，virtual-fs/mini-bash/just-bash → core。

**工具链**（全仓统一）：`typescript@7`（tsgo 原生编译器，`tsc --noEmit` 型检查）· `tsdown`（ESM+CJS+d.ts）· `vitest@4`（每包完整单测，覆盖率门槛 90% lines）· `pnpm` workspace + catalog 统一依赖版本 · `ai@^7` peerDependency。

## 阶段总览与依赖

```
P0 monorepo 脚手架 ──▶ P1 core 接口+定义层 ──▶ P2 virtual-fs ──▶ P4 loop+session ──▶ P5 skills ──▶ P6 mini-bash+bash工具 ──▶ P7 sdk门面+L3 ──▶ P8 文档/示例/验证 ──▶ P9 just-bash 全语法档
                                          └──▶ P3 AI SDK step runner（与 P2 并行）
```

---

## P0 · monorepo 脚手架 — 状态：✅ 完成（2026-07-10，工单 P0-1）

- **目标**：四包骨架可构建、可测试、可型检查。
- **涉及文件**：`pnpm-workspace.yaml`、`tsconfig.base.json`、各包 `package.json`/`tsconfig.json`/`tsdown.config.ts`、根 `vitest.config.ts`、`.gitignore`、CI 占位。
- **实际改动**：四包骨架落地（每包占位 `src/index.ts` + 冒烟测试 + tsdown 产出 ESM/CJS/d.ts/d.cts）；catalog 固定 `typescript@^7.0.2`/`vitest@^4.1.10`/`tsdown@^0.22.4`/`ai@^7.0.20`/`zod@^4.4.3`；`ai` 在 core 与 sdk 均为 peer(`^7`)+dev；根 `packageManager` 固定 `pnpm@10.18.0`；根 v8 覆盖率（lines 90%）经 `pnpm coverage` 聚合校验。
- **与计划的偏差**：① 计划所列根 `vitest.workspace.ts` 在 vitest@4 已移除，改用根 `vitest.config.ts` 的 `test.projects`；每包另有独立 `vitest.config.ts`（vitest@4 配置向上搜索会误命中根 projects 配置导致包内单跑失败）。② tsdown 需显式 `fixedExtension: false` 才产出 `.js/.d.ts` 而非 `.mjs/.d.mts`。③ sdk 占位刻意不跨包 re-export（各包 exports 指向 dist，typecheck 先于 build 会失败），真正门面归 P7。**遗留观察项**：typescript@7 触发 tsdown 的 unmet peer 警告与 "experimental API" 提示，dts 产出正常，升级 tsdown 时复查。

## P1 · @runko/core 接口与定义层 — 状态：✅ 完成（P1-1 2026-07-10、P1-2 2026-07-11）

- **目标**：tech-spec §4.1 全部类型与纯函数——`RunkoFS`/`FileStat`(含 mimeType/annotations/reference)/`RunkoExec`/`Tool`/`ApprovalPolicy`/`defineAgent`/`defineTool`/`defineSkill`/事件类型/`SessionState` zod schema。无运行时逻辑。
- **P1-1 实际改动**：`types.ts`（JsonValue+jsonValueSchema/ToolReturn/FileStat/DirEntry/RunkoFS/RunkoExec/Approval 系列/SkillHandle/Tool/ToolContext）、`events.ts`、`state.ts`（modelMessageSchema+SessionState+sessionStateSchema）+ 三个测试文件（26 用例，含 assertNever 穷尽性编译期断言与 ModelMessage 双向赋值兼容断言）。三连命令+根覆盖率（lines 100%）验收全绿。
- **P1-1 偏差与裁量**：① 新增 `@types/node`（lib 仅 ES2022 时 AbortSignal 等需要它，tsgo 不自动发现 `node_modules/@types`）；② SessionEvent 按 spec §4.2 原文为 5 联合成员；③ `messages` 校验用 `z.custom<ModelMessage>` + 结构判别守卫，不逐字段复刻 ai 的联合体（会随 ai 大版本演进产生假阴性）；④ 补全 spec 未定义字段：`DirEntry = FileStat & { name }`、`Usage` 精简三聚合字段、`RunkoError.message`、`createdAt` 为 epoch ms、`fsSnapshot?: JsonValue`、`Tool` 为类型擦除非泛型接口。
- **P1-2 实际改动**：`tool.ts`（ToolDefinition + defineTool）、`agent.ts`（AgentDefinition/defineAgent/BuiltinToolName 九名联合/READ_ONLY_TOOLS）、`skill.ts`（Skill/defineSkill，三个 loader 归 P5）+ 三个测试文件；全包 7 文件 50 用例、coverage lines 100%。P1-1 预铺的 Tool 擦除设计经"两个异构 defineTool 产物无 as 放入同一 Record<string, Tool>"测试实证。
- **P1-2 偏差（已同步 tech-spec §4.1）**：defineTool 泛型加约束 `In extends z.ZodType<JsonValue>`、`Out extends ToolReturn = ToolReturn`（spec 原文均无约束）——无约束时函数体内对类型擦除态 `Tool` 的赋值过不了 tsc，加 `as` 违反类型硬规范；约束语义上只是显式化"工具输入来自模型 JSON、返回值须落 ToolReturn 进事件系统"的既有事实。有 `z.date()` 负例证明约束真实拦截非 JSON schema。

## P2 · @runko/virtual-fs — 状态：✅ 完成（P2-1、P2-2 均 2026-07-11）

- **目标**：tech-spec §4.4——`MemoryFS`/`OverlayFS`/`DirFS` 只读底层/路径规范化与越界拒绝/mime 扩展名推断/annotations/reference 条目（含 `resolveReference`）/`diff()/writeBack()/snapshot()`；文件工具八件套（[builtin-tools](../tech/builtin-tools.md) §1.1–§1.8）。
- **P2-1 实际改动**：`src/{path,mime,memory,overlay,dir,diff,index}.ts` + 7 测试文件 80 用例（越界拒绝/mtime 单调递增/mime 兜底/reference 两分支/overlay 穿透·覆盖·墓碑·复活/diff 真三态/writeBack 幂等/snapshot·restore/DirFS 只读+ignore 子树隐藏）；包覆盖率 lines 96%。
- **P2-1 五项裁量（②–⑤ 已回填 tech-spec §4.4）**：① 工厂为独立函数 fromMemory/fromDirectory；② MemoryFS.diff() 空基线全报 created，真三态归 OverlayFS.diff()；③ glob() 只匹配文件不匹配目录；④ 墓碑只记目录路径、diff/writeBack 现场经 base.glob 展开 + base 需遵守 NotFoundError 契约；⑤ DirFS ignore 为"路径或祖先目录命中即隐藏子树"的 v1 简化语义。**遗留观察项**：NotFoundError 契约现居 virtual-fs，是否上移 core 列 P7 评审；`FileDiff.kind`（created/modified/deleted）与 `file_change`（add/update/delete）为两个刻意不同的表面。
- **P2-2 实际改动**：`src/tools/{shared,read-file,write-file,edit-file,delete-file,move-file,list-dir,glob,grep,index}.ts` + 9 测试文件（全包 16 文件 155 用例，P2-1 零回归）；`createFileTools(opts)` 工厂注入 `ReadStateStore` + `onFileChange` 接缝（P4 对接点）；builtin-tools §4 文件工具验收项全数落实（read→edit→再 edit、旁路 mtime 拒绝、edit 未命中/多命中指导文案、delete 递归、move=delete+add、四个读类工具截断标记、reference 两分支、路径越界由 FS 层拒绝）；包覆盖率 lines 95.67%。
- **P2-2 八项裁量（关键四项已回填 builtin-tools §1.12）**：① 本包新增直接依赖 `zod`；② `ToolErrorResult` 显式索引签名；③ 二进制判定乐观策略（octet-stream 兜底当文本）；④ move-file 遇 reference 整体拒绝；⑤ 2000 行/256KB 硬上限；⑥ offset≥EOF 返回 isError 指导；⑦ 空目录 delete 也需 recursive；⑧ 受控例外仅 shared.ts `describeError` catch 窄化。

## P3 · @runko/core AI SDK step runner — 状态：✅ 完成（2026-07-11，工单 P3-1，与 P2 并行）

- **目标**：tech-spec §4.3——runko Tool → AI SDK `tool()`（无 execute）转换、单步 `streamText` 封装、`fullStream` → 内部事件映射、`responseMessages`/usage 提取。
- **实际改动**：`convert.ts`（convertTool/convertTools，`tool<JsonValue, never, Record<string, unknown>>` 显式钉死三类型参数，省略 execute）、`step.ts`（StepEvent 四变体判别联合/StepToolCall/ResponseMessage 重建/StepResult/runStep 为 `AsyncGenerator<StepEvent, StepResult>`）+ 两测试文件（MockLanguageModelV4 + simulateReadableStream，三类流、tool-input-delta 流式聚合、无 execute 断言、stop/tool-calls 分支、abort reject、usage 提取）；`src/model` 覆盖 lines 100%。
- **裁量**：① `tool()` 的 CONTEXT 用 `Record<string, unknown>`（ai 未导出的 `Context` 别名的结构原文，`never` 会在 needsApproval 逆变位置报错）；② StepEvent 只映射四类块，start/end 边界块丢弃；③ abort 无专门事件分支（`fullStream` 吐 abort 后正常关闭，result promises reject 从 `next()` 自然抛出，abort 语义归 P4）；④ `StepResult.usage` 用 AI SDK 原生 `LanguageModelUsage`。
- **遗留项**：`result.fullStream` 在 ai@7 为 deprecated 别名（非弃用名 `result.stream`）——**归下一个触碰 `core/src/model/` 的工单做一处标识符替换**（P4-2 已清偿）；spec §4.3 已补"措辞校准"。

## P4 · @runko/core loop + Session — 状态：✅ 完成（P4-1、P4-2 均 2026-07-11）

- **目标**：tech-spec §4.2/§4.5/§4.8——`createSession`/`send`/`stream`/审批链（per-tool + session 兜底 + `once` 记忆）/readState（mtime 判据）/`file_change`/`plan_update` 派生/maxTurns/abort/`update-plan` 工具/上下文上限。
- **P4-1 实际改动**：`approval.ts`（evaluateApproval/OnceApprovalMemory/createOnceApprovalMemory）、`runtime.ts`（executeToolCall/ToolCallResult/DerivedDataCollector/createDerivedDataCollector）、`tools/builtin/update-plan.ts`（createUpdatePlanTool/PlanStore/createPlanStore）+ 三测试文件（全包 12 文件 116 用例）；三新文件 lines 100%。审批链场景覆盖超出工单：once 的 deny 不记忆、按 toolName 键入、no-arbiter 指导文案含两种补救。
- **P4-1 裁量（②已回填 tech-spec §4.5）**：① 派生数据接缝为 `DerivedDataCollector`（recordFileChange/recordPlanUpdate/drain），"同一 collector 不得并发共享"限制注释在案；② session `onApproval` 字面 always/once 与"未配置"同归 no-arbiter deny 分支；③ `ToolCallDerivedData` 字段名 changes/items 对齐事件字段；④ once 记忆接口 + 便利实现，所有权归 session（P4-2）；⑤ execute throw 后本次已上报的派生数据仍随 failed 结果带出。
- **P4-2 实际改动**：`loop.ts`（runTurn/事件翻译/终止条件/回填层）、`session.ts`（createSession/Session/SessionOptions/Input/TurnResult/RunkoSessionError/占位 FS/createSessionReadState）、`agent.ts` 增 `maxContextTokens?`、`model/step.ts` 一处 `fullStream`→`stream`（P3 遗留清偿）、根脚本与 CI 顺序改 **build→typecheck→test**（core devDep virtual-fs 与 virtual-fs prodDep core 的 workspace 循环，build 按拓扑序可解）+ 37 新用例（core 15 文件 153 用例；core/src 98.5% lines）。集成测试以宿主姿态真实走通 createFileTools 链路。
- **P4-2 八项裁量（②⑧ 已回填 tech-spec §4.2/§4.8）**：① `tool-input-delta` 阶段不驱动 item 事件——**列为扩展点遗留项**；② `SessionOptions.readState?/derivedData?` 注入位（先有鸡后有蛋，未注入行为不变）；③ CI 顺序根因（cyclic devDep）；④ `ctx.update()` 进度缓冲后重放；⑤ 回填用 `ToolResultOutput` 三变体 text/error-text/execution-denied；⑥ image 块映射非弃用 `FilePart`；⑦ 修复占位 FS 同步 throw 违反 Promise 契约的真实 bug（改 `Promise.reject`）；⑧ `max_turns` 最后一步工具执行完再判失败 + 计数语义澄清（step 粒度）。

## P5 · skills — 状态：✅ 完成（P5-1 2026-07-11，与 P6-1 并行）

- **目标**：tech-spec §4.6——SKILL.md 解析（packaged+flat）、`<available_skills>` 注入、`load-skill` 工具、`/.skills/` 挂载、`ctx.getSkill`。
- **P5-1 实际改动**：`skills/{loader,registry}.ts`（三加载器/frontmatter 自实现/`<available_skills>`/createGetSkill/mountSkillFiles/skillMountPath）、`tools/builtin/load-skill.ts`、`skill.ts` 追加 `Skill` 值命名空间、session/loop/runtime 接线（getSkill 真实现替换 P4-1 占位）+ 两 fixture（packaged pdf-fill 含附属文件、flat commit-helper）+ 41 新用例（core 17 文件 194 用例；loader/registry/load-skill 三文件 lines 100%）。兼容性验收：两 fixture 不改动直接加载。
- **P5-1 裁量（③④ 已回填 tech-spec §4.6）**：① `Skill` 类型/值同模块共存（与 RunkoFS 跨包冲突先例本质不同，保留 spec 字面 `Skill.fromDirectory(...)` 调用形态）；② getSkill 接线为可选字段（createSession 路径恒传真实现）；③ flat 首行按字面取整行 + frontmatter 仅顶层 key: value；④ 挂载时机 createSession 同步发起 / stream() 首行 await，fs 未注入+带 files 首次 send 以指导性错误 reject。

## P6 · @runko/mini-bash + bash 内置工具 — 状态：✅ 完成（P6-1/P6-2/P6-3/P6-4 均 2026-07-11）

- **目标**：`RunkoExec` 消费端全链路——core 的 `bash` 工具（条件激活/defaultApproval/describe() 拼接/onOutput→item.updated）+ `workspace` 语法糖；`@runko/mini-bash`：命令解析（引号、单层管道 `|`）+ 六命令纯函数实现（`cat`/`grep`/`find`/`tail`/`head`/`echo`，对齐 POSIX 常用子集），全部跑在注入的 `RunkoFS` 上，不支持重定向/变量/子 shell/通配符展开。
- **P6-1 实际改动**（与 P5-1 并行，只动 packages/mini-bash/）：`src/{path,parse,exec,index}.ts` + `src/commands/{cat,grep,find,tail,head,echo,shared,types,index}.ts` + 10 测试文件 113 用例（每命令旗标对照、13 种未支持语法逐项报错、三段管道组合、引号内管道符不作管道、三种 abort、onOutput 分片、describe() 断言、**全命令+管道跑完后 FS snapshot 不变的全只读断言**）；包 lines 95.77%、commands 目录 100%。
- **P6-1 六项裁量（③⑥ 已回填 tech-spec §4.5a）**：① 测试 FS 用 virtual-fs fromMemory + 手写故障 wrapper；② find 用 readdir+stat 自行递归而非 fs.glob；③ exec() 全失败路径 resolve ExecResult 不 reject（解析 2/未知命令 127/超时 124/abort 130）；④ grep 文件缺失 2 区别无匹配 1（POSIX 三态）；⑤ find -name 单段 basename 为唯一通配符生效点；⑥ 路径 `..` 越界静默 clamp 到根（解释器语义，安全边界在 FS 层）。
- **P6-2 实际改动**：`tools/builtin/bash.ts`（createBashTool：64KB 双流独立截断、describe() 拼接、defaultApproval 透传、onOutput→ctx.update、reject 兜底带契约诊断文案）、`session.ts` 接线（SessionOptions.exec/workspace + 互斥同步 throw + assembleTools 第三个条件注入分支）+ 两测试文件（全仓 46 文件 495 用例）；builtin-tools §4 bash 五项验收 + 模式 A 端到端（write-file 后 bash cat 立即可见、旁路写使 readState 失效→edit-file 被拒直至重读）全数落实。
- **P6-2 四项裁量（① 已回填 builtin-tools §1.10）**：① defaultApproval 未声明兜底 `"review"`（审批是安全机制，不对未知第三方实现做乐观假设）；② exec() reject 兜底在 bash.ts 内部捕获、给"注入的 RunkoExec 违反契约"诊断文案；③ workspace/fs/exec 互斥用**同步 throw**（装配期静态误用应立即失败，与 fs 缺省的延迟指导性报错刻意区分）；④ session.ts 覆盖率分支为构造上不可达的防御死分支。
- **P6-3 实际改动**（用户直接指示）：mini-bash 新增 `;`/`&&`/`||`/`2>&1`——纯控制流/流重排，零写面，保持全只读与 `defaultApproval: "allow"` 自洽；维持拒绝 `>`/`>>`/`<`（写面走 write-file 工具），被拒文案升级为指引 write-file/cat。`parse.ts` 重写为四层结构 `ParsedScript`（script→chain→pipeline→stage）+ `exec.ts` 的 `runChain`/`runPipeline`（短路状态语义 `a && b || c` 对齐真实 shell）；+40 用例，parse.ts lines 100%。裁量：parse() 返回类型升级（非公共导出）、命令名惰性按管道校验（对齐真实 shell 短路）、防御死分支不加 v8 ignore。
- **P6-4 实际改动**（用户要求 cd，主线程定双层语义）：`commands/{cd,pwd}.ts`（cd 仅 stat 校验零写面、经包内部 `CommandResult.cwd` 上报；pwd 纯只读）+ `exec.ts` 的 `instanceCwd` 闭包状态（脚本内链间穿透 / 管道内 POSIX 子 shell 无效果 / 跨 exec() 实例级持久化 / `req.cwd` 显式优先且仅作那次起点）；+26 用例，RunkoExec 接口零改动。**已知边界微瑕（不返工）**：显式 req.cwd 且脚本内 cd 恰好落回同一起点时不更新实例记忆（病理输入）。

## P7 · @runko/sdk 门面 + 扩展能力 — 状态：✅ 完成（P7-1/P7-2/P7-3/P7-3R 均 2026-07-11）

- **目标**：`@runko/sdk` re-export 与默认装配（`createSession` 默认 MemoryFS + 文件工具全开）；结构化输出（AI SDK Output/generateObject + 回退）；`toJSON`/`resume`；`localExec`（materialize，出厂 approval "review"）；L3 `loadAgent`/`loadAgentFromFS`（eve 布局兼容；FS 版不做代码求值）。
- **P7-1 实际改动**（与 P7-2 并行，只动 packages/sdk/）：`src/{index,fs,session}.ts` + 5 测试文件 28 用例（sdk 包 lines 100%）。三包 `export *` 汇合 + 三符号具名 re-export；`RunkoFS` 值命名空间落地（本地 `type RunkoFS = CoreRunkoFS` + `const RunkoFS = { fromMemory, fromDirectory }`）；sdk 版 createSession 默认装配（fs 缺省 MemoryFS、八件套经 readState/derivedData 预构造注入通路全开、builtinTools 白名单过滤、宿主同名覆盖）；**五行示例逐行对照测试**（`session.fs.diff()` 经三重载泛型保留具体 FS 类型无 as）。
- **P7-1 四项裁量**：① 具名 re-export 优先于 `export *` 带入绑定（ES 规范语义）；② RunkoFS 类型+值必须两个本地声明（`export type {} from` 属再导出非本地声明，触发 TS2323）；③ fs 具体类型保留用三重载 + 宽实现签名，零 as。**已知类型精度缺口**：预声明变量同时携带 `{ fs, workspace }` 传入时，多余属性检查不生效（TS 仅对对象字面量做 excess property check），运行时由 core 的互斥同步 throw 兜底；④ builtinTools 过滤只管八件套，update-plan/load-skill/bash 的条件注入归 core。
- **P7-2 实际改动**（与 P7-1 并行，只动 packages/core/）：`structured.ts`（generateStructuredOutput/RunkoStructuredOutputError）、`session.ts` 扩展（`send<T>` 重载/toJSON({includeFs})/SessionOptions.resume/hasStarted 语义/toCleanJsonValue 防御规整/快照能力结构探测）+ 两测试文件（core 21 文件 248 用例，全仓 97.69%）。序列化往返端到端、结构化输出三路径（happy/修正重试/预算耗尽）、send 重载类型级断言、抽取轮不回写历史断言均落实。
- **P7-2 五项裁量（③④ 已回填 tech-spec §4.8/§4.2）**：① `generateText({ output: Output.object })` 而非已弃用的 generateObject；② "原生 vs 回退"收敛为单一机制（NoObjectGeneratedError 触发修正重试，至多 3 次调用）；③ 耗尽预算 throw `RunkoStructuredOutputError` 不新增 turn.failed code；④ TurnOptions 不含裸 outputSchema 字段（zod v4 下向公共类型泄漏 unknown），只经 `send<T>` 重载交叉类型出现；⑤ resume 即视为已启动，不重发 session.started。
- **P7-2 发现的跨包 bug（修复归 P7-3）**：`MemoryFS.snapshot()` 对未设置 mimeType 的条目写显式 `undefined` 键，精确落入 jsonValueSchema 拒绝范围——真实 MemoryFS 的 `includeFs` 往返若无防御必失败。core 已在 toJSON() 信任边界做防御规整（`toCleanJsonValue`）；根因修复（写入侧省略未设置键）+ 回归测试并入 P7-3。
- **P7-3 实际改动**（验收结论：**通过但有一项返工**，见 P7-3R）：任务 0 snapshot 根因修复；`exec/local.ts`（localExec：模式 B 物化/mtime 回收、模式 C 直跑，出厂 `"review"`，describe() 自动生成 ≤150 token）；`load/{load-agent,load-agent-fs}.ts` + `./load` 子路径导出 + eve 布局 fixture；全仓 55 文件 667 用例全绿，lines 97.92%。orchitector 补做 vitest 之外的**真实 node 冒烟**（node 直调 dist/load.js 对 .js fixture）。
- **P7-3 六项裁量（②③ 已回填 tech-spec §4.5a/§4.7；⑥ 返工）**：① fs 经构造参数注入、缺失构造期同步抛错；② cwd 语义分叉（模式 C 真实路径/模式 B 虚拟路径）；③ agent.ts/json 只读 5 标量字段、目录扫描是 tools/skills/instructions 唯一事实来源；④ loadAgentFromFS 连 agent.json 都不读；⑤ `./load` 子路径与主入口并存；⑥ **返工项 P7-3R**：load-agent.ts 4 处字段级 `as` 须改为类型守卫。
- **P7-3R 返工完成（P7 整体 ✅）**：4 处 `as` 全消除——`isZodSchemaLike`（safeParse 探针）、`ToolLikeRecord` 字段直接声明为 `Tool["execute"]`/`Tool["inputSchema"]`、`isLanguageModelInstance`（specificationVersion/provider/modelId 三探针）；`grep " as "` 仅剩 `import * as` 三行；+4 负例，load-agent.ts lines 100%。**披露的越界改动（验收接受）**：`test/fixtures/agent-dir/tools/*.js` 改 fixture 是返工的必然连带（safeParse 探针使旧纯对象 inputSchema 必然被拒）。

## P8 · 文档、示例与端到端验证 — 状态：✅ 完成（P8-1/1b/1c + P8-2，2026-07-11；唯一挂起项：npm 裸名 `runko` 决策）

- **目标**：各包 README + 根 README；`examples/`（内存 diff、目录挂载、skills、mini-bash、自定义 exec 注入、结构化输出、streaming）；编写 `docs/misc/plans/verification.md` 验证方案并执行（真实 API 端到端，产品文档 §6 成功标准逐条核验）。
- **P8-1 实际改动**：根 + 四包 README 共 5 个；`examples/` 六脚本 + `shared/` + `setup-node-modules.mjs`（符号链接模拟发布后消费姿态）+ `typecheck.mjs` + examples/README；`docs/misc/plans/verification.md` 方案部分（§1 运行步骤 / §2 十三用例逐条映射 §6 四条成功标准 / §3 examples 运行矩阵 / §4 回归命令清单 / §5 回填区）。README 代码块与实际 API 面逐条对照**零发明能力**。
- **P8-1 六项裁量**：① examples 独立 typecheck 脚本（演练发布后消费姿态），**examples typecheck 入 CI**；② `.ts` 扩展名 + allowImportingTsExtensions；③ README 五行示例主用 gateway 字符串、provider 直连以注释行呈现；④ 05-custom-exec 补 `onApproval` 并把无仲裁者 fail-closed 语义变成教学点；⑤ docs/misc/plans/verification.md 只交方案（执行归 P8-2）；⑥ examples/node_modules 符号链接被 .gitignore 覆盖。
- **P8-1b/1c 实际改动**：`examples/07-streaming.ts`（脚本化 MockLanguageModelV4 真实走 createSession+stream 全链路）；`shared/model.ts` 双路径 `resolveModel`（DeepSeek 直连主路径 + gateway 字符串回退）；`@ai-sdk/deepseek` 挂 sdk devDep。
- **P8-1b/1c 三项裁定**：① sdk devDep+lockfile 追加工单显式授权；② coder 误触发一次真实 DeepSeek 调用记录不返工（无凭据泄漏）；③ `RUNKO_MODEL` 双路径语义重载接受不改名。**同型陷阱**：`.env` 就位后 `env -u` 不再构成"缺配置"模拟。
- **P8-2 执行完毕（P8 ✅，v1 收官）**：docs/misc/plans/verification.md 全部 13 用例 + §3 矩阵 14 格**全部通过并回填**（真实模型 DeepSeek 直连，用户授权）。三条追加项落实：① CI 追加 examples setup+typecheck 两步；② 05 §4 基线更正为实测 **58 文件 697 用例 / lines 97.95%**；③ npm 裸名未定挂起。执行亮点：**06 真实命中结构化输出兼容回退路径**（DeepSeek 无原生 JSON schema，AI SDK 注入 system message——§4.8 设计的 provider 回退场景首次真机实证）；3-2 以 anthropics/skills 真实 `xlsx` skill（53 附属文件）零改动加载+注入+挂载；1-1 五行示例真实跑通且真实目录零改动。**docs/logic/engine/features/core-sdk.md §6 四条成功标准全部达成，runko v1 施工收官。**

## P1–P7 全仓终检（2026-07-11，orchitector 亲测，为 P8-2 铺底）

- **干净检出全序列**：`rm -r packages/*/dist` 后 `pnpm build → typecheck → test → coverage` 全绿；四包合计 **671 用例**（core 331 / virtual-fs 159 / mini-bash 153 / sdk 28），全仓覆盖 **lines 97.93%**（阈值 90%）、statements 96.49%、functions 98.09%。
- **硬性规范全量 grep**（四包 src）：`any` 零真实命中（仅注释与 `AbortSignal.any` API 名）；`as` 断言零真实命中（仅 `import * as` 与字符串字面量，`as const` 合法收窄不计）；非空断言 `!` 零命中；`unknown` 共 23 处，全部收敛在受控家族——catch 窄化 `describeError`（7 文件各一）、state.ts 的 ModelMessage 结构守卫（4）、load-agent.ts 动态 import 边界守卫（8）、step.ts `toJsonValue`、其余零散守卫入参——**无一泄漏公共 API 签名**。
- 结论：P1–P7 交付面满足类型硬性规范与工具链约束。

## P9 · @runko/just-bash 全语法档 bash（v1.1，用户立项 2026-07-11）— 状态：✅ 完成（P9-1/P9-2 均 2026-07-11，**v1.1 收口**）

- **背景**：Claude 系模型高频产出 `if/for/while/case` 脚本，mini-bash 语法面不够；用户拍板基于 [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash) 升级。选型调研与适配设计见 tech-spec §4.5b（IFileSystem 接口已对照 `just-bash@3.1.0` 实际 d.ts 核实）。
- **目标**：新增第五包 `@runko/just-bash`——`justBash(fs: RunkoFS, opts?): RunkoExec`：RunkoFS→IFileSystem 适配器 + RunkoExec 表面（defaultApproval "allow"、describe()、timeoutMs→AbortController 超时 124、onOutput 结束时一次性回报、cwd 实例持久语义）+ executionLimits 暴露。**分档并存**：mini-bash 保留零依赖档；just-bash 包不进 sdk 依赖（wasm 大件）。
- **P9-1 实际改动**：新建 `packages/just-bash/`（catalog 加 `just-bash: ^3.1.0`）：`src/{path,fs-adapter,exec,index}.ts` + 5 测试文件 67 用例，包 lines 100%；全仓五包 764 用例、聚合 98.1%。覆盖：降级表逐项、控制流全谱真实脚本（if/elif、C 式 for、while/until、case、函数+local、参数扩展、glob、四种重定向、管道、短路）、重定向写落 RunkoFS 可见+mtime 抬升、cwd 四联+双实例隔离、超时/中止、契约（语法错误/未知命令/缓存预热失败均 resolve 非 reject）、e2e 两件套。lockfile 核验：just-bash 仅在本包依赖。
- **P9-1 八项裁量/发现（①③ 已回填/修正 tech-spec §4.5b）**：① **实证推翻 spec 断言**——just-bash 的 `Bash.exec()` 每次调用无状态（cd 只在 `result.env.PWD`），适配器以闭包 instanceCwd+读回 env.PWD 复刻 P6-4 语义；② 协作式取消救不了悬挂 fs，沿 mini-bash raceAbort 独立保底、自定退出码；③ getAllPaths 同步 vs glob 异步——"每次顶层 exec 刷新同步缓存"折中（入 §4.5b 已知限制）；④ ExecutionLimits 经索引派生；⑤ readFileBytes 用 latin1 等价实现；⑥ cp/mv 目录递归经 glob、空子目录不参与；⑦ 限额默认收紧约一个数量级；⑧ workspace 加 minimumReleaseAgeExclude + allowBuilds 显式拒绝两个可选原生绑定（守零二进制）。
- **P9-2 实际改动（P9 ✅）**：`examples/08-just-bash.ts`（双段：直调 justBash 跑 if/for/函数/重定向脚本 + 模型段控制流任务）、setup-node-modules.mjs 链接两条、五处 README 分档说明、docs/misc/plans/verification.md 的 4-4 用例与 08 矩阵行；全仓 63 文件 764 用例、examples typecheck exit 0。orchitector 收口执行：4-4 与 08 矩阵真机回填（**模型真实产出 for+if+算术扩展脚本经 justBash 执行**，onOutput 恰 1 次非流式契约实测）；修正根 README 示例计数漂移（六→八）。
- **P9-2 裁定**：① 计数漂移由 orchitector 顺手修正；② 05 状态行暂时不一致刻意（回填归口）；③ **第三次 .env 同型陷阱**（记 correction 不返工），**05 §3 已加制度化防呆警告**（"回归验证前必须移开 examples/.env"）；④ 确定性段 stdout 精确断言与 onOutput 单次计数经独立核对。

---

## 后续阶段（归属其他功能，交叉链接）

core-sdk v1/v1.1 收官后，仓库继续演进；下列阶段深度依赖或改动 core，但主领域属其他功能，详细拆单/验收见对应施工文档，本页不重复：

- **P10 · 云沙盒工作区三接入包**（v1.2）：`@runko/sandbox-{e2b,vercel,cloudflare}`，三家均以模式 A 同源工作区（`RunkoFS & RunkoExec`）交付，均不进 sdk 依赖。→ 见 [sandbox 施工进展](../../../host/contract/plans/sandbox.md)。
- **P11 · 真实项目端到端示例**：Vercel 沙盒内 frontend-design skill 驱动设计优化 + Git 工作流（clone→装 skill→分支→改→commit→push→PR）。→ 见 [chat-webapp 施工进展](../../../ingress/plans/chat-webapp.md)。
- **P12 · Chat Agent Web 应用**（apps/web + apps/node-server）：对话驱动 runko agent 在沙盒里改代码/开 PR；含 P12-5 人在回路、P13-1 transcript 减量、P12-4 断线可续。→ 见 [chat-webapp 施工进展](../../../ingress/plans/chat-webapp.md)。
- **P13-5 · UIMessage 单账本 + 三值审批 + 工具改名**（2026-07-15 立项）：**深改 core**——① 内置工具名 snake_case→kebab-case（`read-file`/…，`bash`/`glob`/`grep` 不变）；② core 账本迁移（`SessionState.messages`→`RunkoUIMessage[]`、`convertToModelMessages` 现场推导、`session.stream()` 吐 ai `UIMessageChunk` + runko data 部件、`SessionEvent`/`SessionItem`/`TurnResult.items` 退役、`nimbo_state_json` 取消）；②c 审批三值重构（`ApprovalPolicy` allow/review/review-once/deny + `ApprovalOutcome`/`HumanDecision`、删 `ApprovalDecision.updatedInput`、`review` 先发 `tool-approval-request` chunk 再阻塞经 `onReview` 等裁决、审批分类器 `onApproval` 取代 shouldAutoAllow）。**本页 tech/features 已按 P13-5 落地状态书写**（对应 `packages/core/src/{session,loop,runtime,approval,types}.ts` 当前实现）。定案与完成状态见 [single-ledger 施工进展](../../orchestration/plans/single-ledger.md)。

## 变更记录

> 说明：本表是整条施工线（P0–P13）的**共享历史记录**，按迁移要求完整保留，不删条目。P10 之后的条目主领域属其他功能（见上"后续阶段"交叉链接），列此仅为历史连续性。

| 日期 | 阶段 | 记录 |
|---|---|---|
| 2026-07-15 | P13 | **P13-5 UIMessage 单账本 + 三值审批 + 工具改名**（验证实验 P13-5a GO 判定后立项，[single-ledger](../../orchestration/plans/single-ledger.md)）：六单串行——① 工具名 snake_case→kebab-case（`read-file`/…/`ask-user`，`bash`/`glob`/`grep` 不变）；② core 账本迁移（`SessionState.messages`→`RunkoUIMessage[]`、`convertToModelMessages` 现场推导模型上下文、`session.stream()` 吐 ai UIMessageChunk + runko data 部件、`SessionEvent`/`SessionItem`/`TurnResult.items` 退役、`nimbo_state_json` 取消）；②c 审批三值重构（`ApprovalPolicy` allow/review/review-once/deny + `ApprovalOutcome`/`HumanDecision`、删 `ApprovalDecision.updatedInput`、`review` 先发 `tool-approval-request` chunk 再阻塞经 `onReview` 等裁决、审批分类器 `onApproval` 取代 shouldAutoAllow）；③ server 单账本（删 `nimbo_state_json`、`agent_events` 存 message + chunk 两类、`GET events` 返回 `{frames}`）；④ web 渲染 UIMessage 部件；⑤ 测试补强；⑥ 文档修订。core+外围 928、server 153、web 待收口；本会话不 commit，改动累积工作区 |
| 2026-07-14 | P13 | **P13-1 transcript 减量**（持久化分析后用户逐项确认）：`item.updated` tick 改 ephemeral——只广播、不落库、**不占 seq**（信封 seq 变可选：有 seq ⇔ 持久可回放）。动机：tick 携带累积全文，落库量为消息长度平方级（实证 98% 行是 tick）。持久流因 ephemeral 不占号而**无空洞**，崩溃后 seq 续起无漂移。取舍：turn 中崩溃后半截打字机不可回放。server 102→113、web 112→117 |
| 2026-07-13 | P12 | **P12-5 人在环上**（用户立项）：① bash 审批链——gateWorkspace 包装沙盒 workspace（defaultApproval "allow"）+ session onApproval 桥（approval-policy 三档：dangerous 默认/all/off），turn-runner 审批桥（pendingApprovals + `approval.requested/resolved` wire 事件落库可回放 + 240s 超时自动 deny）+ `POST .../approvals/:callId` 裁决路由；② **ask-user 工具**——onAskUser 注入即注册，`question.asked/answered` 事件对 + `POST .../questions/:callId`；③ web 端 approval/question 独立时间线卡片。runko core 零改动（onApproval 本就是可 await 回调）。server 40→102、web 54→112 用例 |
| 2026-07-12 | P12 | **P12 完成**（用户立项）：chat agent webapp；apps 并入根 workspace（根管线 filter 收窄保 CI 不变）；沙盒生命周期 = persistent + extendTimeout 滚动续期 + 快照休眠/恢复。四需求真机实证 + 浏览器端到端回归揪修 2 个 curl/fake 盲区 bug |
| 2026-07-12 | P12 | **配置整合**（用户追加）：examples/.env + apps/node-server/.env + 根.env 全并入**仓库根 .env 单一事实来源**（15 唯一键）；删三个旧 .env/template |
| 2026-07-12 | P12 | **P12 后续增强**（用户逐条追加）：① transcript store 迁 .transcripts/；② streamdown 渲染 agent_message + reasoning；③ 修 composer 错位；④ **P12-4 断线可续实时流**（turn registry 解耦 turn 与连接 + GET /stream?after 可续传 tail + 客户端挂载即续接） |
| 2026-07-12 | P11 | **P11 开工**（用户立项）：真实项目设计优化 e2e 示例；PAT v1 / npx skills+fromFS / Git 集成部署 / DeepSeek v4 pro / 无审批门。真机段实跑通过并产出真实 PR（ludafa/Schulte-Grid#2、#4） |
| 2026-07-11 | P10 | **P10 开工**（用户立项）：三沙盒接入包 @runko/sandbox-{e2b,vercel,cloudflare}；provider SDK 仅类型依赖；CF 网关形态；真机验证待用户凭证。E2B/Vercel 真机已验证，Cloudflare 待部署 |
| 2026-07-11 | P9 | P9-2（集成收尾）完成，**P9 ✅、v1.1 收口**：08 示例双段真机通过（模型产出 for+if+算术脚本经 justBash 执行）、五处 README 分档零发明、05 的 4-4/08 行回填。第三次 .env 同型陷阱后 05 §3 加制度化防呆警告；根 README 示例计数漂移（六→八）修正 |
| 2026-07-11 | P9 | P9-1（@runko/just-bash 适配器+RunkoExec 封装）完成（v1.1 首张）。**spec §4.5b 两处修正/回填**：cd 持久语义实为适配器闭包实现（实测推翻"just-bash 原生如此"断言）；getAllPaths 同步缓存折中与 cp/mv 空目录限制入"已知限制"。全仓五包 764 用例/98.1% lines |
| 2026-07-11 | P8 | **P8-2 执行完毕，P8 ✅，v1 施工收官**：docs/misc/plans/verification.md 十三用例+14 格矩阵全部通过并回填（DeepSeek 真机；含结构化输出回退路径真机实证、官方 xlsx skill 零改动加载）；CI 追加 examples typecheck；基线实测 697 用例/97.95% lines。**docs/logic/engine/features/core-sdk.md §6 四条成功标准全部达成**。唯一挂起：npm 裸名 `runko` 决策 |
| 2026-07-11 | P8 | P8-1b/1c（07-streaming + deepseek 双路径接入）验收通过：coder 一次误触真实调用记录不返工；orchitector 同型陷阱补充发现（.env 在场时 env -u 不构成缺配置）；RUNKO_MODEL 语义重载接受不改名 |
| 2026-07-11 | P8 | P8-1（README×5 + examples 六脚本与基建 + docs/misc/plans/verification.md 验证方案）完成。README 防发明对照零偏差；六脚本缺 env 干净退出实测；05 十三用例全映射 §6。裁定：examples typecheck 入 CI，coverage 暂不入 |
| 2026-07-11 | P7 | P7-3R 返工完成，**P7 整体 ✅**。三守卫（isZodSchemaLike/isToolLikeRecord/isLanguageModelInstance）消除全部 as；+4 负例。**P1–P7 全仓终检通过**：干净检出全序列 671 用例全绿、lines 97.93%；硬性规范全量 grep 零真实逃逸 |
| 2026-07-11 | P7 | P7-3（任务0+localExec+L3）交付，验收**通过但有一项返工 P7-3R**：load-agent.ts 4 处字段级 as 须改为类型守卫。**spec 回填** §4.5a（localExec cwd 双模式语义、materialize 的 fs 构造注入）、§4.7（配置只读 5 标量字段/目录扫描唯一事实来源/FromFS 不读 agent.json/./load 子路径）。orchitector 以真实 node 补冒烟 |
| 2026-07-11 | P7 | P7-2（结构化输出+toJSON/resume）完成。**spec 回填** §4.8（generateText+Output.object 取代已弃用 generateObject、原生/回退收敛单机制、RunkoStructuredOutputError throw 形态、resume 的 hasStarted 语义）、§4.2（TurnOptions 去除裸 outputSchema 字段）。发现 MemoryFS.snapshot() 显式 undefined 键 bug——core 侧防御规整保留，根因修复并入 P7-3 |
| 2026-07-11 | P7 | P7-1（sdk 门面+默认装配）完成。RunkoFS 值命名空间落地（P2-1 遗留清偿）；五行示例逐行对照测试通过。已知限制：预声明变量同携 fs+workspace 时编译期多余属性检查不生效，运行时互斥 throw 兜底。npm 裸名 `runko` 的发布决策待用户 |
| 2026-07-11 | P6 | P6-4（cd/pwd）完成（用户要求；双层 cwd 语义：链间穿透+实例持久化+req.cwd 优先+管道子 shell 无效果）。+26 用例只动 mini-bash，RunkoExec 接口零改动；已知边界微瑕一处（cd 落回 req.cwd 起点不更新记忆，病理输入）。用户提供 deepseek 凭证，P8-2 API 阻塞解除 |
| 2026-07-11 | P6 | P6-3 完成，P6 恢复 ✅。parse.ts 重写为 ParsedScript 四层结构（+40 用例，parse 100% lines）；裁量：parse() 返回类型升级、命令名惰性按管道校验（对齐真实 shell 短路语义） |
| 2026-07-11 | P6 | **P6-3 开工**（用户直接指示，spec §2 mini-bash 描述行已先行更新）：新增 `;`/`&&`/`\|\|`/`2>&1`（零写面控制流/流重排），维持拒绝文件重定向，被拒文案指引 write-file/cat。P6 状态由 ✅ 回调为 ⏳ 直至 P6-3 验收 |
| 2026-07-11 | P6 | P6-2（core 侧 bash 工具 + exec/workspace 接线）完成，P6 整体 ✅。**04 回填** §1.10：实现未声明 defaultApproval 时兜底 "review"（保守默认）。裁量：reject 兜底带契约诊断文案、互斥同步 throw |
| 2026-07-11 | P6 | P6-1（mini-bash 解释器本体）完成（与 P5-1 并行）。**spec 回填** §4.5a"实现契约"：exec() 全失败路径 resolve ExecResult 不 reject（退出码 POSIX/GNU 惯例）；mini-bash 路径 `..` 静默 clamp（安全边界在 FS 层）。微瑕遗留：shared.ts describeError 注释（下次触碰补，P6-3 已清偿） |
| 2026-07-11 | P5 | P5-1（skills 全链路）完成，P5 ✅（与 P6-1 并行）。**spec 回填** §4.6"语义澄清"：挂载经 RunkoFS 接口/时机 createSession 发起+首次 stream await；getSkill 数据源为 skill.files 非 FS、.text() 惰性 reject；flat 首行按字面、frontmatter 仅顶层 key: value；load-skill 由 skills 隐式控制可被宿主覆盖 |
| 2026-07-11 | P4 | P4-2（loop+session）完成，P4 整体 ✅。**spec 回填** §4.2（SessionOptions.readState/derivedData 注入位）、§4.8（maxContextTokens 定名与校准估算、max_turns 最后一步执行完再判失败、ToolResultOutput 三变体、FilePart、tool-input-delta 与 update 重放两处 v1 取舍）。P3 遗留 fullStream→stream 已清偿；根脚本/CI 顺序改 build→typecheck→test |
| 2026-07-11 | P4 | P4-1（审批链+ToolRuntime+update-plan）完成。**spec 回填** §4.5"无仲裁者语义"：审批请求无人裁决即 deny 带指导；session onApproval 字面 always/once 同归 no-arbiter deny |
| 2026-07-11 | P3 | P3-1（step runner）完成，P3 ✅。**spec 措辞校准** §4.3：ai@7 中 `fullStream` 为 deprecated 别名（正名 `stream`，迁移列遗留）；`ai/test` mock 实名 `MockLanguageModelV4`。裁量：tool() CONTEXT 用 Record<string,unknown>、边界块丢弃、abort 走 reject、usage 用原生 LanguageModelUsage |
| 2026-07-11 | P2 | P2-2（文件工具八件套）完成，P2 整体 ✅。**04 回填** §1.12 施工语义澄清：read-file 二进制乐观判定、预算硬上限、delete 空目录需 recursive、move-file 遇 reference 整体拒绝、createFileTools 接缝与 FileChange/FileDiff 双表面。virtual-fs 新增直接依赖 zod |
| 2026-07-11 | P2 | P2-1（FS 内核）完成。**spec 澄清回填** §4.4：独立工厂函数、glob 只匹配文件、MemoryFS.diff 空基线/真三态归 OverlayFS、RunkoFS 实现的 NotFoundError 契约、墓碑惰性展开、DirFS ignore v1 语义。遗留：NotFoundError 契约是否上移 core 列 P7 评审 |
| 2026-07-11 | P1 | P1-2（L1 定义层）完成，P1 整体 ✅。**spec 修正**：tech-spec §4.1 defineTool 签名同步施工约束 `In extends z.ZodType<JsonValue>`、`Out extends ToolReturn`（原文无约束，无法在不加 as 的前提下通过 tsc） |
| 2026-07-10 | P1 | P1-1（L0 原语+事件+SessionState schema）完成。裁量：catalog 新增 `@types/node`；SessionState 的 messages 校验取"结构安全恢复"级；spec 未定义字段由施工补全 |
| 2026-07-10 | P0 | P0-1 完成。偏差：`vitest.workspace.ts`（vitest@4 已移除）→ 根 `vitest.config.ts` `test.projects` + 每包独立 `vitest.config.ts`；tsdown 显式 `fixedExtension: false`；`packageManager` 固定 `pnpm@10.18.0`。遗留：typescript@7 在 tsdown 侧为 experimental（peer 警告），产物正常 |
| 2026-07-10 | 全部 | **改版为 pnpm monorepo**：`@runko/sdk`(门面)/`@runko/core`/`@runko/virtual-fs`/`@runko/mini-bash` 四包（core 为破循环而增设）；工具链定为 typescript@7(tsgo)+tsdown+vitest@4；新增 mini-bash（纯 TS 解释器跑在 RunkoFS 上）；阶段重排为 P0–P8；施工改由 orchitector/coder sub agent 执行 |
| 2026-07-10 | P1/P2 | FS 扩展元信息与引用条目（tech-spec §4.4） |
| 2026-07-10 | P5→P6 | 命令执行升级为内置 bash 工具 + RunkoExec 注入（tech-spec §4.5a） |
| 2026-07-10 | 全部 | 模型层改为 Vercel AI SDK（tech-spec v3）：删除自研 provider 层，`ai@^7` peerDep |
| 2026-07-10 | 全部 | API 层次改为参考 eve.dev（tech-spec v2）：defineAgent/createSession/Session、defineTool 对齐 eve、skills 双形态、L3 loadAgent |
| 2026-07-10 | — | 计划创建（对应 tech-spec 草案 v1） |
