# Cloudflare Worker Server（产品视角）

> 相关：[技术方案](./tech.md) · [施工进展](./plan.md)
> 相关功能：[沙盒](../../host/sandbox/feature.md)（[网关形态](../../terms.md)）· [示例集](../examples/feature.md)（11 号 Cloudflare 示例的真机段用它）
> 代码：[apps/cloudflare-worker-server](../../../apps/cloudflare-worker-server/README.md)
> 术语：[沙盒](../../terms.md) · [网关形态](../../terms.md) · [工作区](../../terms.md)
> **它不是一个独立功能，是一个双角色的部署壳**——两个角色的设计权威都不在本层：**角色②（网关）**是 `@nimbo/sandbox-cloudflare` 的服务端半边，看 [host/sandbox](../../host/sandbox/tech.md) §6；**角色①（Worker 里跑 agent）**是[六档部署](../../agent/agent-kernel/feature.md)里 ④a Durable Object 那一档的可行性验证，那一档将来落在 `@nimbo/durable-object`（宿主层包）。本文只讲「这个工程怎么接线、怎么部署」。归属结论见 [agent/agent-kernel/plan](../../agent/agent-kernel/plan.md#两个容易归错层的-app-文档2026-08-11-复核)。

## 要解决什么问题

Cloudflare [沙盒](../../terms.md)有个结构性约束：**它只能从 Worker 内部经 Durable Object binding 访问**。这让想用 CF 沙盒的人立刻撞上两个问题：

1. **「我的 agent 跑在自己电脑上，怎么用 CF 沙盒？」**——连不上。必须自己在 CF 账号里立一个 Worker 当[网关](../../terms.md)，把 nimbo 的协议翻译成对沙盒的调用。此前我们只给一份三个文件的参考片段，读者得自己拼出一个 wrangler 项目。
2. **「那把服务端整个搬进 Worker 呢？」**——可行性完全未知：模型调用、agent loop、沙盒驱动在 workerd 里到底跑不跑得起来，没人验证过。

本项目**一次回答这两个问题**：一个完整可部署的 Worker 工程，既是问题 1 要的那个网关，也是问题 2 的可行性答案。

## 目标用户与使用场景

| 你是谁 | 你要什么 | 用哪个角色 |
|---|---|---|
| 想在自己电脑上跑 agent、但用 CF 沙盒 | 一个现成的网关，部署完填两个环境变量就能用 | 角色 ②（`/gateway/*`） |
| 想把 nimbo 服务端整个放进 Worker | 一份跑通了的参考实现，看清接线形状与坑 | 角色 ①（`/agent` 等） |
| 在评估「nimbo 能不能上 Workers」 | 实测结论与仍未解决的卡点清单 | 读[施工进展](./plan.md) |

## 用户可见行为

部署后（或本地 `pnpm dev`）可用的路由：

| 路由 | 作用 | 需要模型凭证 |
|---|---|---|
| `GET /` | 自述：列出所有路由 | 否 |
| `GET /health` | 存活检查（不碰沙盒） | 否 |
| `GET /sandbox-check` | **探针**：exec + 文件往返 + 同源工作区校验，证明 Worker 能驱动真沙盒 | 否 |
| `GET /debug/exec?cmd=…` | 调试：直接在沙盒里跑一条命令，用来独立核验 agent 的自述 | 否 |
| `POST /agent` | 跑一次真 agent 会话，body `{"prompt":"..."}` | 是 |
| `ALL /gateway/*` | **对外网关端点**：供任意 Node 机器上的 `cloudflareWorkspace({url, token})` 连入 | 否（需网关 token） |

> 建议先跑 `/sandbox-check`——它把「Worker 里到底能不能驱动真沙盒」这个最大未知数单独隔出来，且零模型凭证。它过了再跑 `/agent`。

**接入网关时最容易错的一点**：客户端的 `url` 要**带 `/gateway` 前缀**（`https://<worker>.workers.dev/gateway`）。

## 范围与非目标

**做**：Worker 入口、CF 沙盒直连接线、一次完整 agent 会话、对外网关端点。

**不做**（做了它就变成产品移植，不再是示例）：

- **不是 `apps/node-server` 的 Workers 版**。D1 替换 `better-sqlite3`、better-auth 移植、chat 的 conversations/messages 路由与 SSE 续传，都不在范围内。
- **不为你托管 CF 环境**。仍需你**自备 CF 账号 + Workers Paid 计划**（CF 沙盒无免费层，$5/月起）。变化在于：以前是「拷三个文件进你自己的项目」，现在是「直接部署这个现成项目」。
- **不解决沙盒语义落差**。CF 沙盒 idle 睡眠后文件系统丢失，与 Vercel/E2B 的「含未提交改动快照恢复」不等价——chat 主打的「多轮改动累积、唤醒后原样还原」在 CF 上兑现不了。这是产品决策，不是工程量。
- **Cloudflare 仍不是 chat 的[沙盒 provider](../../terms.md) 选项**（[沙盒 provider](../../host/sandbox-provider/feature.md) 只支持 `vercel`/`e2b`），本项目不改变这一点。

## 成功标准

- `GET /sandbox-check` 三项全过（exec 返回真实 Linux 容器；`writeFile`/`readFile` 往返一致；bash `cat` 读到文件工具刚写的内容）。
- `POST /agent` 跑完一次真会话，且**经 `/debug/exec` 独立核验**沙盒内文件确实存在、内容与模型自述逐字一致（不采信模型自述）。
- 外部 Node 机器上的 `cloudflareWorkspace({url, token})` 能经 `/gateway/*` 完成同样的文件与 exec 操作——即[示例集](../examples/feature.md) 11 号的真机段可跑。

前两项已实测通过，第三项待用户部署后回填，详见[施工进展](./plan.md)。
