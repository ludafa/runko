---
title: "集群控制台（cluster-console）— 施工进展"
slug: cluster-console
view: 施工
layer: 宿主层
module: —
packages: ["@runko-chat/node-server", "@runko-chat/web", "@runko/agent"]
tags: ["集群", "控制台", "节点下线", "施工"]
related: ["host/node/features/cluster-console.md", "host/node/tech/cluster-console.md", "host/node/plans/cluster-lab.md"]
---
# 集群控制台 — 施工进展

> 术语见 [术语表](../../../terms.md)。[功能手册](../features/cluster-console.md) · [技术方案](../tech/cluster-console.md)。

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| O0 | 三份文档 + 术语表四个词条 | ✅ |
| O1 | `@runko/agent`：`shutdown({ finishWindowMs })` 先等再中止 | ✅ |
| O2 | 节点侧：下线闸门 + 断开直播连接 + `index.ts` 接线 | ✅ |
| O3 | 运维容器：`src/ops/` + compose 服务 + nginx 重试 | ✅ |
| O4 | 控制台 API：`/api/console/*` | ✅ |
| O5 | 前端 `/console` 页面 | ✅ |
| O6 | 集群端到端：功能手册 §5 的四条成功标准 + 验证方案 | ✅ |

**顺序**：O1、O3 互不依赖，可以并行；O2 要 O1 的新参数；O4 要 O3 的接口；O5 要 O4 的 OpenAPI；O6 最后。

## 各阶段

### O1 · 框架：`shutdown` 先等再中止

- **目标**：技术方案 §5。`finishWindowMs` 缺省 0，不传就是老行为。
- **文件**：`packages/agent/src/runtime.ts`（`shutdown`、`ShutdownResult`、`AgentRuntimeOptions.shutdown`）；测试放 `packages/agent/test/`。
- **验收**：
  1. `finishWindowMs` 内自然跑完的轮不被中止，`finished` 计数对；
  2. 窗口到点还在干活的轮被 `ABORT_REASON_SHUTDOWN` 中止；
  3. 窗口期间转入等人的轮被挂起，不等到窗口结束；
  4. 窗口期间入队一律 `shutting_down`；
  5. 不传 `finishWindowMs` 时现有 shutdown 测试全部照过。
- **产出**：changeset（`@runko/agent` minor）。

### O2 · 节点侧

- **目标**：技术方案 §4。
- **文件**：`apps/node-server/src/offline.ts`（新：闸门中间件 + 进程级下线信号）、`app.ts`（挂闸门）、`routes/chat.ts`（SSE 合并下线信号）、`routes/chat-ws.ts`（WS 合并下线信号、1012 关闭）、`index.ts`（`shutdown()` 顺序 + `SHUTDOWN_FINISH_WINDOW_MS`）。
- **验收**：闸门对「浏览器请求 / 转发请求 / health」三类分流正确；下线信号触发后 WS 收到 1012、SSE 结束；`SHUTDOWN_FINISH_WINDOW_MS` 不配时行为不变。

### O3 · 运维容器

- **目标**：技术方案 §6、§7。
- **文件**：`apps/node-server/src/ops/`（`docker.ts` 走 unix socket 的最小客户端、`app.ts` 三个接口、`index.ts` 入口）；`docker/cluster.compose.yml`（`ops` 服务、节点的 `RUNKO_OPS_URL`/`RUNKO_OPS_TOKEN`/`SHUTDOWN_FINISH_WINDOW_MS`）；`docker/cluster.nginx.conf`（`proxy_next_upstream`）。
- **验收**：令牌不对 401；停非 `node` 服务的容器 404；「下线中」状态按 §7.3 推导；compose 起得来、`ops` 不对宿主机开端口。

### O4 · 控制台 API

- **目标**：技术方案 §2、§8。
- **文件**：`apps/node-server/src/routes/console.ts`（新）、`schemas/console.ts`（新）、`agent/runko-tables.ts`（加租约查询）、`app.ts`（挂路由）。
- **验收**：会话按 `holder` 挂到节点；心跳超时标 `stale`；没配运维容器时 `controllable: false`；运维容器够不着时带 `opsError`、会话部分照常。

### O5 · 前端

- **目标**：技术方案 §9。
- **文件**：`apps/web/src/routes/_app/console.tsx`、`pages/console.tsx`、侧栏入口（`layouts/app-layout.tsx`）、重新生成的 API 客户端。
- **验收**：三种状态显示正确、倒计时走、下线二次确认、`controllable: false` 时按钮置灰带说明。

### O6 · 端到端与验证方案

- **目标**：功能手册 §5 四条成功标准在真集群里跑通，写进验证方案。
- **文件**：`apps/node-server/test/e2e/` 下新增一组集群场景；本文件末尾「验证方案」一节。

## 变更记录

- 2026-09-25：代码审查后返工，修了 5 个行为问题、5 处清理：
  - **nginx 会把一条消息重发两三遍**：转发时等持有者开口超时，请求可能已经送到，却回了 503，而 nginx 对 503 的 POST 会换节点重发。改成等超时回 504（`forward.ts` 的 `RESULT_UNKNOWN_STATUS`），连不上仍回 503。起轮路由的 OpenAPI 加了 504。多副本那几份文档与 e2e 断言（冻住持有者那两条）同步改成 504。见[技术方案 §6](../tech/cluster-console.md)。
  - **没配 Redis 时，转发来的直播一连上就断**：下线后，别的节点转发来的 SSE 不再合并下线信号。
  - **单进程关闭时先断直播、后等轮收尾**，浏览器收不到「服务重启」那一帧：`offline.ts` 拆成 `goOffline()`（关闸门）与 `disconnectStreams()`（断直播）两个方法；只在配了 Redis 广播时提前断，否则等轮收尾之后再断。
  - **控制台下线/上线失败时页面没有提示**：加了一条错误提示条。
  - **`finished` 把被用户停止、跑失败的轮也算成自然跑完**：每一轮收尾时记下结束状态（`ActiveTurn.endStatus`），只数 `completed`。
  - 清理：`drainMs` 等名字撞了术语表里「别用」的 drain，改名为 `finishWindowMs`（环境变量 `SHUTDOWN_FINISH_WINDOW_MS` / `CLUSTER_OFFLINE_FINISH_WINDOW_MS`），术语表新增[等待窗口](../../../terms.md)；删掉注释里的工单号；删掉一处类型断言；「可信转发」的判断合并成 `forward.ts` 的 `isTrustedForward` 一份；控制台总览的查库与问运维容器改成并发；等待窗口循环里的 `Promise.all` 只建一次。
  - 新增测试：框架 1 个（用户停止不算 finished，共 195 个）；node-server 1 个（转发来的直播不断）+ 改 2 个闸门用例（共 540 个）；web 2 个（下线/上线失败有提示，共 364 个）。
  - **集群端到端（同日）**：`test:cluster` 第一次跑挂在 §4.2——持有者容器被 `docker kill` 后回的是 504 不是 503。原因：容器的 IP 从网络里消失，连接不被拒、也没人应，只能等满转发超时，跟「冻住」分不出来。判断：504 是对的（请求送没送到确实未知；而且接管之前换哪个节点重试都要转给这个死掉的持有者，503 只会让 nginx 白重试三次）。改的是测试：§4.2 与 lab S5 断言改成 504，e2e 辅助函数改名 `retryWhileHolderUnreachable`（503/504 都继续等接管）；功能手册的「稍后再试」一节讲清两个状态码的区别。之后四套全绿：`test:cluster` 8/8、`test:cluster-console` 5/5、`test:lab` 9/9、node-server 540。
  - **浏览器实测**（agent-browser + 手动起的三副本集群，演示模型）：
    - 下线直播所在的持有者节点：不到 2 秒直播换到节点 1，文字持续增长；这一轮 `completed`，节点日志 `finished: 1, aborted: 0`，退出码 0。
    - 下线期间浏览器的 `presence` POST 打到被下线节点，拿到 503 后 nginx 换节点重试，浏览器收到 200。
    - 控制台：拦截下线请求让它失败，页面出现「下线失败」提示；随后「重新上线」成功并清掉提示。
    - 冻住持有者（2 秒多）后经 nginx 发消息：504，用时 2020 ms（只转了一次，没被重发）；nginx 日志只有一行、没有换节点告警；解冻后账本里这条消息 0 份、没有重复。
- 2026-09-24：O6 完成。端到端测试 `test/e2e/cluster-console.e2e.test.ts`（5 个用例覆盖 6 个场景）第一次真跑就撞出两个真问题，都已修：
  - **运维容器起不来**（`connect EACCES /var/run/docker.sock`）：镜像缺省 `USER node`，而 socket 只给 root。compose 里给 `ops` 服务加 `user: root`（不用「加进 docker 组」：那个组的 gid 每台机器不一样）。单测全绿但真机起不来——这类问题只有真起一次容器才看得见。
  - **节点刚退出时 nginx 卡 60 秒**：Docker 内部域名缓存里还有旧地址时，连接挂到缺省的 60 秒连接超时才换节点。nginx 加 `proxy_connect_timeout 2s`。
  - 顺手修掉 `check:doc-links` 报的 8 处注释路径深度不对；其中两处在 OpenAPI 的 `summary` 里，会原样进生成的前端客户端，改成不带链接的纯文字。
- 2026-09-24：O3–O5 测试补齐，未发现缺陷。node-server 新增 58 个（运维容器 app 21、docker 客户端 13（临时 unix socket 上的假 Docker）、控制台 API 16、ops-client 8），共 539 个全绿；web 新增 17 个（格式化 8、页面 9），共 362 个全绿。
- 2026-09-24：O4、O5 代码完成。实际改动与偏差：
  - O4：新文件 `src/console/ops-client.ts`（调运维容器，3 秒超时，失败分三类：连不上 / HTTP 错 / 响应形状不对）、`schemas/console.ts`、`routes/console.ts`；`runko-tables.ts` 加 `listActiveLeases`；`persistence.ts` 导出 `resolveTakeoverMs()`，控制台判 `stale` 与租约用同一个阈值。下线/上线失败的状态码定为 409 / 404 / 502，兜底节点状态填 `online`，理由见技术方案 §8。
  - O5：新增依赖 `@tanstack/react-query`（前端第一次用）；请求手写 `fetch` + 生成的 zod 校验，不用 kubb 的请求函数（它不看 `response.ok`）。入口放在顶部导航，和「设置」并排。
  - 审查时发现并修掉一个真问题：运维容器的 compose 项目名写死成 `runko-cluster`，端到端测试另起的那套集群会去停开发者手上那套的节点。改成启动时自查（技术方案 §7.2）。compose 另加三个时长开关 `CLUSTER_OFFLINE_FINISH_WINDOW_MS` / `CLUSTER_OFFLINE_GRACE_MS` / `CLUSTER_OFFLINE_KILL_S`，给端到端测试压时间轴用。
- 2026-09-24：O1、O2 测试补齐。框架新增 8 个用例（`test/shutdown-finish-window.test.ts` 6 个、`test/suspend.test.ts` 2 个），共 194 个全绿；node-server 新增 13 个（闸门 9 个、SSE 断开 2 个、WebSocket 1012 关闭 2 个，WebSocket 用真服务器测），共 481 个全绿。
- 2026-09-24：O1–O3 代码完成。实际改动与偏差：
  - O1：「中途转入等人」用 500 毫秒轮询实现。`HumanBridge` 的 `onApprovalPending` 钩子在构造时绑死给外部通知用，挂不上第二个监听者，为此重构超出本批范围。两处旧测试对 `ShutdownResult` 做逐字段比较，补了 `finished: 0`。
  - O2：闸门在 `src/offline.ts`，进程级单例 `nodeOffline` 从 `routes/chat.ts` 导出（那里已经有 `resolveNodeIdentity()` 的结果）。`SHUTDOWN_FINISH_WINDOW_MS` 写错或为空一律当 0。
  - O3：运维容器的 `GET /nodes` 返回裸数组；多了一个可选变量 `RUNKO_OPS_DOCKER_SOCKET`（socket 路径）。审查时补了两处：重复下线**幂等**（返回原截止时刻，不重新计时）；`docker stop` 失败时撤掉「下线中」标记。Dockerfile 不用改（`dist/ops` 随 build 进镜像）。
- 2026-09-24：O0 完成。拍板两件事：强杀由挂 `docker.sock` 的运维容器做（`docker stop -t 120`）；控制台放 chat 前端、不设管理员。

## 验证方案

### 一、自动化（跑完即退）

| 命令 | 验什么 | 实际结果（2026-09-24） |
|---|---|---|
| `pnpm --filter @runko/agent test` | `shutdown({ finishWindowMs })` 的八种时序 | 194 个全绿 |
| `cd apps/node-server && pnpm typecheck && pnpm lint && pnpm test` | 闸门、直播断开、运维容器、控制台 API | 539 个通过，22 个跳过（要 Docker 的端到端，缺省不跑） |
| `cd apps/web && pnpm typecheck && pnpm lint && pnpm test` | 控制台页面：按钮映射、二次确认、倒计时、置灰、分组 | 362 个全绿 |
| `cd apps/node-server && pnpm test:cluster-console` | **真集群**端到端，六个场景（见下表） | 5 个用例全绿，98 秒 |
| `cd apps/node-server && RUNKO_TEST_CLUSTER=1 npx vitest run test/e2e/cluster.e2e.test.ts` | 原有集群端到端没被 nginx / compose 的改动带坏 | 8 个全绿，253 秒 |
| `pnpm check:doc-links`、`pnpm docs:check`、`pnpm docs:build` | 注释里的文档路径、front matter、全站死链 | 全部通过 |

端到端用自己的 compose 项目 `runko-cluster-console-e2e` 和一组独立端口（入口 3980），**不碰开发者手上那套 `runko-cluster`**；时间轴压成「让轮跑完 8 秒 / 收尾 3 秒 / 强杀 15 秒」。

| 场景 | 预期 | 实测 |
|---|---|---|
| 1 短轮所在节点下线 | 这一轮正常跑完；下线期间经 nginx 的请求全部 2xx；节点在 8+3 秒内自己退出 | 退出码 0，请求无一失败 |
| 2 长轮所在节点下线 | 到 8 秒时这一轮被中止（「服务重启」），节点在强杀前自己退出 | 退出码 0，8.3 秒 |
| 3 让轮跑完的时长远大于强杀期限 | 到强杀期限被 SIGKILL | 退出码 137，8.2 秒（该组强杀期限 8 秒） |
| 4 重新上线 | 节点恢复健康，新会话能落到它上面 | 通过 |
| 5 WebSocket | 连在被下线节点上的直播收到 1012，经 nginx 重连后接着收到这一轮的帧直到结束 | 1012；重连后收到 22 帧 |
| 6 nginx 重试 | 直连被下线节点得 503；同样的请求（含 POST）经 nginx 得 2xx | 通过 |

### 二、手工（浏览器）

1. 重新起集群（**要重新 up**，旧集群里没有运维容器）：`CLUSTER_CLIENT_URL=http://localhost:5273 pnpm --filter @runko-chat/node-server cluster:up`，前端 `pnpm chat:web`。
2. 登录，顶部导航点「集群控制台」：三个节点都是「在线」。
3. 开两个会话各发一条长消息：控制台上它们挂到对应节点下，心跳秒数在跳。
4. 点其中一个节点的「下线」→ 确认框文案与功能手册 §3.3 一致 → 状态变「下线中 1:59」并倒数。
5. 回到那个会话：直播短暂重连后继续，这一轮正常结束。
6. 约 1 分半内那个节点变「已下线」；点「重新上线」，十几秒后回到「在线」。
