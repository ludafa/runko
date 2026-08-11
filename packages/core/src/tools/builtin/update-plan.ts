/**
 * `update-plan`（docs/core/builtin-tools/tech.md §1.11）：整表替换的任务计划工具。
 * 纯内存状态、零安全面——"存储经注入，session 拥有"（§1.11 原文）：本工单
 * 只定义 `PlanStore` 接口（get/set 两个方法）+ 一个便利的内存实现，真正的
 * 生命周期归属（跨轮次持久与否）留给 P4-2 的 session。
 *
 * `onPlanUpdate` 回调是派生数据接缝的"生产者"一端（消费者与设计理由见
 * `runtime.ts` 头部注释、先例见 `@nimbo/virtual-fs` 的
 * `createFileTools(opts).onFileChange`）：整表替换成功后同步调用，工具本身
 * 不发 `SessionEvent`（docs/core/builtin-tools/tech.md §0.6 同款规则，`file_change`/`plan_update` 都遵守）。
 */
import { z } from "zod";
import { defineTool } from "../../tool.js";
import type { Tool, ToolReturn } from "../../types.js";

export interface PlanItem {
  text: string;
  completed: boolean;
}

/** session 范围的计划状态存储；纯内存，形状由调用方注入。 */
export interface PlanStore {
  getItems(): PlanItem[];
  setItems(items: PlanItem[]): void;
}

/** `PlanStore` 的便利默认实现：纯内存变量，无持久化。 */
export function createPlanStore(): PlanStore {
  let items: PlanItem[] = [];
  return {
    getItems: () => items,
    setItems: (next) => {
      items = next;
    },
  };
}

export interface CreateUpdatePlanToolOptions {
  store: PlanStore;
  /** 整表替换成功后上报新的完整条目列表；派生数据接缝，设计理由见 runtime.ts。 */
  onPlanUpdate?: (items: PlanItem[]) => void;
}

const inputSchema = z.object({
  items: z.array(z.object({ text: z.string(), completed: z.boolean() })),
});

export function createUpdatePlanTool(opts: CreateUpdatePlanToolOptions): Tool {
  return defineTool({
    description:
      "Replace the entire task plan with the given list of items (a full-table replace, not an incremental " +
      "patch — always pass every item, including ones that haven't changed). Use this to track progress on " +
      "multi-step tasks: call it once to set the initial plan, then again whenever an item's status changes or " +
      "the plan itself needs to change. Keep item text short and action-oriented. Marking an item completed only " +
      "records that it is done — it does not verify the underlying work.",
    inputSchema,
    execute: (input): ToolReturn => {
      opts.store.setItems(input.items);
      opts.onPlanUpdate?.(input.items);

      const completed = input.items.filter((item) => item.completed).length;
      return `Plan updated: ${input.items.length} item(s), ${completed} completed.`;
    },
  });
}
