/**
 * 这个 demo 的 agent 装配：**一个内存工作区 + 一个纯 TS bash**，不碰任何云沙盒。
 *
 * 刻意这么选：这个 demo 要证的是**持久化**能不能用，不是沙盒能不能用。少一个外部
 * 依赖，e2e 就少一个 flaky 来源，读的人也少一层要理解的东西。
 *
 * 模型走 `createModel` 注入。生产装配可以传真模型；e2e 传一个脚本化的假模型，
 * 这样「跑一轮」是确定性的——测持久化时，模型的不确定性纯属噪音。
 */
import type { AgentDefinition, NimboExec, NimboFS } from "@nimbo/core";
import { miniBash } from "@nimbo/mini-bash";
import { fromMemory } from "@nimbo/virtual-fs";
import type { LanguageModel } from "ai";

export interface DemoAgentOptions {
  /** 每轮拿一个模型。e2e 传脚本化的假模型；生产传真的。 */
  createModel: () => LanguageModel;
  instructions?: string;
}

export interface DemoWorkspace {
  fs: NimboFS;
  exec: NimboExec;
}

/**
 * 每个会话一个内存工作区，**进程内缓存**。
 *
 * 注意这跟持久化是两回事：账本/队列/裁决落库、跨重启存活，但**工作区不落库**
 * ——进程一重启文件就没了。真实宿主这里接的是云沙盒（那才有快照与恢复）。
 * 本 demo 不做这一层，见文件头。
 */
export function createWorkspaces(): (conversationId: string) => DemoWorkspace {
  const cache = new Map<string, DemoWorkspace>();
  return (conversationId) => {
    const existing = cache.get(conversationId);
    if (existing !== undefined) {
      return existing;
    }
    const fs = fromMemory({
      "/README.md": "# persist-demo\n\n这是一个内存工作区，进程重启就没了。\n",
    });
    const workspace: DemoWorkspace = { fs, exec: miniBash(fs) };
    cache.set(conversationId, workspace);
    return workspace;
  };
}

export function demoAgent(opts: DemoAgentOptions): AgentDefinition {
  return {
    model: opts.createModel(),
    instructions:
      opts.instructions ??
      "你是 persist-demo 里的助手。工作区是一个内存文件系统，可以用 bash 读写它。",
  };
}
