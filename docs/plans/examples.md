# 示例集 examples（实验田）— 施工进展

> **相关**：产品手册见 [features/examples](../features/examples.md)；技术方案见 [tech/examples](../tech/examples.md)。
> **依赖**：原 13 号迁出的去向见 [plans/single-ledger](./single-ledger.md)；示例验证语义承接 [plans/verification](./verification.md)。

## 背景

`examples/` 此前靠手工符号链接脚本（`setup-node-modules.mjs`）伪装「发布后消费姿态」，改造只做了一半且自相矛盾：源码相对路径已按 `examples/src/` 写好、文件却还平铺在根（导致 `.env` 解析到仓库根的父目录，是坏的）；README 整篇过时（还教已删的脚本、还留一整节「为什么不是 workspace 包」，结论正好反了）；`tsconfig.json` 与 `pnpm-workspace.yaml` 注释对「是否进 CI」两处打架。

目标：把 `examples/` 收尾成一个**自洽、打开即用的 pnpm workspace 子项目**——一块 [实验田](../terms.md)。

## 四个已确认决策

| # | 决策 | 说明 |
|---|---|---|
| 1 | 源码迁入 `examples/src/` | 代码相对路径已按此写好，迁入后 `model.ts` 无需改 `..` 层数 |
| 2 | 新增 `pnpm example <n>` 便捷 [runner](../terms.md) | 按编号/名字前缀 glob 到文件跑；新增示例零维护；原生 `node` 命令作等价备选 |
| 3 | 12 是 demo 不是 test | 去掉 `.e2e.test.ts` 后缀正名，留在 examples |
| 4 | 13 挪进 `@nimbo-chat/server` | 离线段改写成 vitest 用例进 CI；真机段留 git 历史（用户拍板产品归属在 chat，知情其语义实现在 core 后仍选 server） |

## 阶段拆单与状态

| 阶段 | 目标 | 状态 |
|---|---|---|
| 0 · 文档先行 | features/tech/plans 三份 + terms 词条（示例集/runner）；三份互链 | ✅ 完成 |
| 1 · 源码迁入 `src/` | `git mv` 01–12 + shared → `src/`；12 正名去 `.e2e.test.ts` 后缀 | ✅ 完成 |
| 2 · 13 挪进 server 并改写 | 新增 `apps/server/test/agent/uimessage-single-ledger.test.ts`（离线 3 用例）；删 13；改 `loop.ts:31` 注释 | ✅ 完成 |
| 3 · 便捷运行入口 | 新增 `examples/run.ts`；`package.json` 加 `example` 脚本 | ✅ 完成 |
| 4 · 配置自洽 + CI 接入 | `tsconfig.json` include 收窄 + 修正「NOT wired into CI」矛盾注释；`pnpm-workspace.yaml` 注释校正 | ✅ 完成 |
| 5 · README 重写 | 删旧脚本指引与「为什么不是 workspace 包」整节；新 `pnpm install` + `pnpm example` 流程；清单 01–12（12 标 demo） | ✅ 完成 |
| 6 · CHANGELOG + 验证 | CHANGELOG 顶部加条目引用三份文档；跑端到端验证 | ✅ 完成 |

## 验收结论

- **13 迁移**：新 server 测试 `uimessage-single-ledger.test.ts` 3 用例全绿；`@nimbo-chat/server` 全量 **11 文件 / 222 用例**通过；server typecheck exit 0。13 已 `git rm`，examples 根只剩 `run.ts`；全库无残留旧文件名引用（唯一出现是 `loop.ts:31` 有意的迁移指引）。
- **配置**：`examples` typecheck exit 0（include 收窄后仍绿）；`pnpm example 01` 跑通（根 `.env` 已配 DeepSeek，跑到模型驱动段）。
- **文档**：feature/tech/plan 三份 + README 四方互链；terms 补齐「示例集」「runner」词条。

## 变更记录

- **2026-07-19**：完成阶段 0/4/5/6 收尾（承接更早已落地的阶段 1/2/3）。修复了通道故障期两处未落地的「幻影编辑」——`package.json` 的 `example` 脚本、`tsconfig.json` 的 include 收窄，本次补齐。清理了阶段 1 遗漏的 5 处 12 号旧路径引用（`08`/`12` 文件头 + `apps/server/src/agent/` 三处注释）。13 的真机段处理取舍（只迁离线段、真机段留 git 历史）记入 `.lantie_history`。
- **2026-07-19（追加）**：按用户要求把整个 `CHANGELOG.md` 重构为 CLAUDE.md 规定的逐条块格式（`## (type/slug) 标题 (时间) (author)`，最新在顶部），历史条目从 git commit 回填真实日期+作者；推翻了本轮更早「CHANGELOG 遵从文件自声明的 Keep-a-Changelog」的判断（该纠正记入 `.lantie_history`）。
- **遗留**：`docs/plans/verification.md` §1/§2 仍有对已删 `setup-node-modules.mjs`/`typecheck.mjs` 的操作性引用与「examples 不是 workspace 包」旧框定——属 core-sdk 验证文档的历史记录，留其下次专门修订，未在本次跨功能改动。
