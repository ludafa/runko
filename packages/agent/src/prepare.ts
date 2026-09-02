/**
 * 宿主能力之一：**工作区**，以及与它一起交付的那批「只对这一轮成立」的东西。
 *
 * 为什么是一个 `prepareTurn` 钩子而不是一个 `workspace` 工厂：真实宿主在
 * [起轮装配](../../../docs/terms.md)那一刻要一次性备齐的东西，不止是 fs/exec——还有
 * 这一轮从沙盒里扫出来的 [skill](../../../docs/terms.md)、按仓库/分支拼出来的
 * instructions、宿主自己的工具（联网搜索等）、以及**审批分类器**（危险命令清单 +
 * [会话级授权](../../../docs/terms.md)，那是产品决策，只有宿主知道）。把它们拆成七八个
 * 独立选项，每个都得再传一遍 `conversationId` 才能取到同一批数据，没有意义。
 *
 * 最简形态仍然只有一行：`prepareTurn: () => ({ fs, exec })`。
 *
 * **生命周期归轮编排管、创建归宿主管**（[架构总纲 §2.2](../../../docs/architecture/tech/agent-kernel.md)
 * 的判据二）：框架每轮调它一次，拿到的东西只在这一轮用；[保活](../../../docs/terms.md)
 * 已经下沉在沙盒适配器里，框架不插手。
 */
import type {
  ApprovalPolicy,
  RunkoExec,
  RunkoFS,
  Skill,
  Tool,
} from "@runko/core";
import type { SessionTelemetry } from "@runko/core";
import type { LanguageModel } from "ai";

import type { TurnInput } from "./types.js";

export interface PrepareTurnContext {
  conversationId: string;
  /** 这一轮的输入（含 `userId`/`meta`——宿主拿它匹配自己的授权）。 */
  input: TurnInput;
  /** 这一轮的轮号（1-based，从账本推的）。 */
  turnNumber: number;
  /**
   * 这一轮的中止信号。**装配期间被[停止](../../../docs/terms.md)时它就会 abort**——
   * 宿主可以把它透进自己那些远程调用（取沙盒、扫 skill），别再白跑。
   */
  signal: AbortSignal;
}

/**
 * 宿主为这一轮备好的东西。**最少只要给出执行面**（`fs`/`exec`，或同源的
 * `workspace`），其余全可省略。
 */
export interface TurnPreparation {
  fs?: RunkoFS;
  /** 注入即激活 core 的内置 `bash` 工具。 */
  exec?: RunkoExec;
  /** [模式 A（同源工作区）](../../../docs/terms.md)的语法糖：一个对象同时实现两个接口。与 `fs`/`exec` 互斥。 */
  workspace?: (RunkoFS & RunkoExec) | undefined;
  /** 覆盖 `agent.model`（按会话切模型时用）。 */
  model?: LanguageModel;
  /** 覆盖 `agent.instructions`（宿主要把仓库/分支烤进提示词时用）。 */
  instructions?: string;
  /** 在 instructions 之上追加（多租户注入场景）。 */
  instructionsAppend?: string;
  /** 这一轮可用的全部 skill——由宿主从沙盒扫出来传入，框架不读沙盒。 */
  skills?: Skill[];
  /** 宿主自己的工具（联网搜索等）。与 `agent.tools` 合并，同名以这里为准。 */
  tools?: Record<string, Tool>;
  /**
   * 这一轮的**审批分类器**（三值 `allow`/`review`/`deny`）。危险命令清单与
   * [会话级授权](../../../docs/terms.md)都是产品决策，归宿主。
   *
   * 注意**没有** `onReview`——[人审通道](../../../docs/terms.md)是框架自己的桥，
   * 宿主经 `runtime.submitDecision(...)` 把人的答复送进来，不该另开一条。
   */
  onApproval?: ApprovalPolicy;
  telemetry?: SessionTelemetry;
  /**
   * 真正喂给模型的文本，缺省即 `input.text`。
   *
   * 两者分开，是为了让宿主能在**不污染账本**的前提下给模型追加话术（典型用途是
   * [skill 提及](../../../docs/terms.md)那行系统提示）：用户看到的仍是自己打的那句，
   * 模型收到的多一行。提示行刻意不进账本——界面上显示一段本该隐形的系统话术很丑，
   * 而且它对后续轮没有价值，留着只是持续占 token。
   */
  modelText?: string;
  /** 这一轮结束后调用（收尾之后、交棒之前）。抛错只记日志，不影响已完成的收尾。 */
  dispose?: () => void | Promise<void>;
}

export type TurnPreparer = (ctx: PrepareTurnContext) => TurnPreparation | Promise<TurnPreparation>;
