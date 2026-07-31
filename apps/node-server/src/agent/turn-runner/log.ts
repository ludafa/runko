/**
 * 本目录的日志旁路（打点覆盖设计定案：turn/step/tool call 级别可观测性）。
 *
 * 整个文件是一个**纯 tap**：只读地看每一个 chunk 记一行，绝不改变 chunk 的流转
 * 与持久化行为（`drive.ts` 的 `driveTurn` 在 `emit.emitChunk` **之前**调
 * `logChunk`，见那里的注释）。
 */
import type { NimboChunk } from '@nimbo/core';

import type { LogFields, Logger } from '../../logger.js';
import { truncate } from '../../logger.js';

/** 本目录所有日志的固定 scope。 */
export const LOG_SCOPE = 'turn-runner';

/** `driveTurn` 记 `turn 开始` 时 `text` 预览的字符数上限。 */
export const TEXT_PREVIEW_LENGTH = 120;

/** `tool-input-available` 记 `input` 预览的字符数上限。 */
const TOOL_INPUT_PREVIEW_LENGTH = 200;

/**
 * 工具 `input`/`output` 在 ai 的 `UIMessageChunk` 词汇表里就是 `unknown`
 * （`@nimbo/core`'s `state.ts` 头注释记录过的同一个"受控例外"——nimbo 的
 * 工具集编译期完全动态，没有字面量联合可收窄）；这里只把它安全转成一行
 * 预览文本，不假设其具体形状。
 */
function previewUnknown(value: unknown, maxLength: number): string {
  if (typeof value === 'string') return truncate(value, maxLength);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return truncate(json, maxLength);
  } catch {
    // 循环引用/不可序列化——退化到 String()。
  }
  return truncate(String(value), maxLength);
}

/** `tool-output-available` 的"输出大小"——JSON 序列化后的字符数，量级足够日志判断用途，不追求精确字节数。 */
function measureOutputSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json.length;
  } catch {
    // 循环引用/不可序列化——退化到 String()。
  }
  return String(value).length;
}

/** 把任意抛出物转成一行可记的文本——`drive.ts`/`start.ts` 的 catch 分支共用。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 一次工具调用的结算日志，攒到对应的 `data-tool-timing`（`completedAt`）
 * chunk 抵达才真正落一行——耗时必须从这个 chunk 读（"保持单一来源"：
 * `@nimbo/core`'s loop 是唯一产出起止时间戳的地方，见工单设计定案），
 * 不能自己在这里另打一份 `Date.now()` 时钟去凑耗时。
 */
export interface PendingToolSettlement {
  level: 'info' | 'warn';
  message: string;
  fields: LogFields;
}

/**
 * Chunk-level log tap — called once per chunk `drive.ts`'s `driveTurn` while
 * loop consumes, strictly *before* `emit.emitChunk` (read-only, never mutates
 * or withholds a chunk — see this file's header "纯 tap"). Mutates the three
 * maps threaded in from `driveTurn`'s own locals: `pendingApprovalRequests`
 * (`approvalId` → the `Date.now()` this tap observed the request) and
 * `pendingSettlements` (`toolCallId` → the not-yet-logged settlement line,
 * parked until its `data-tool-timing` `completedAt` update arrives — "保持
 * 单一来源": duration is always read off that chunk, never a second
 * `Date.now()` pair kept here) — both are `driveTurn`-local, one turn each,
 * so nothing survives across turns to leak. Returns the possibly-bumped step
 * counter (`start-step`/`finish-step` share one running count) since a
 * plain number can't be mutated through a reference the way the two `Map`s
 * are.
 */
export function logChunk(
  log: Logger,
  conversationId: string,
  chunk: NimboChunk,
  stepIndex: number,
  pendingApprovalRequests: Map<string, number>,
  pendingSettlements: Map<string, PendingToolSettlement>,
): number {
  switch (chunk.type) {
    case 'start-step': {
      const next = stepIndex + 1;
      log.info(LOG_SCOPE, 'step started', { conversationId, step: next });
      return next;
    }
    case 'finish-step': {
      log.info(LOG_SCOPE, 'step finished', { conversationId, step: stepIndex });
      return stepIndex;
    }
    case 'tool-input-available': {
      log.info(LOG_SCOPE, 'tool call started', {
        conversationId,
        toolName: chunk.toolName,
        callId: chunk.toolCallId,
        input: previewUnknown(chunk.input, TOOL_INPUT_PREVIEW_LENGTH),
      });
      return stepIndex;
    }
    case 'tool-output-available': {
      pendingSettlements.set(chunk.toolCallId, {
        level: 'info',
        message: 'tool call completed',
        fields: {
          conversationId,
          callId: chunk.toolCallId,
          outputSize: measureOutputSize(chunk.output),
        },
      });
      return stepIndex;
    }
    case 'tool-output-error': {
      pendingSettlements.set(chunk.toolCallId, {
        level: 'warn',
        message: 'tool call errored',
        fields: {
          conversationId,
          callId: chunk.toolCallId,
          errorText: chunk.errorText,
        },
      });
      return stepIndex;
    }
    case 'tool-output-denied': {
      pendingSettlements.set(chunk.toolCallId, {
        level: 'warn',
        message: 'tool call denied',
        fields: { conversationId, callId: chunk.toolCallId },
      });
      return stepIndex;
    }
    case 'tool-approval-request': {
      pendingApprovalRequests.set(chunk.approvalId, Date.now());
      log.info(LOG_SCOPE, 'tool approval requested', {
        conversationId,
        approvalId: chunk.approvalId,
        callId: chunk.toolCallId,
        automatic: chunk.isAutomatic,
      });
      return stepIndex;
    }
    case 'tool-approval-response': {
      const requestedAt = pendingApprovalRequests.get(chunk.approvalId);
      pendingApprovalRequests.delete(chunk.approvalId);
      log.info(LOG_SCOPE, 'tool approval resolved', {
        conversationId,
        approvalId: chunk.approvalId,
        approved: chunk.approved,
        waitMs:
          requestedAt === undefined ? undefined : Date.now() - requestedAt,
      });
      return stepIndex;
    }
    case 'data-tool-timing': {
      // 同一调用最多三次更新（`@nimbo/core` 的 startToolTiming /
      // markToolExecutionStart / completeToolTiming，三段生命周期见 state.ts）：
      // 纯 `startedAt` 那次早由上面的 `tool-input-available` 分支记过"tool call
      // started"，跳过；补上 `executionStartedAt` 那次记一行 debug（排队/审批
      // 结束、真正开始执行——queueMs 即等了多久）；补上 `completedAt` 那次放出
      // 攒着的结算行，durationMs 是**真实执行耗时**（2026-07-16 定案），排队
      // 等待落在 queueMs 里，两者相加才是用户在界面上看到的全程等待。
      const { toolCallId, startedAt, executionStartedAt, completedAt } =
        chunk.data;
      if (completedAt === undefined) {
        if (executionStartedAt !== undefined) {
          log.debug(LOG_SCOPE, 'tool call executing', {
            conversationId,
            callId: toolCallId,
            queueMs: executionStartedAt - startedAt,
          });
        }
        return stepIndex;
      }
      const pending = pendingSettlements.get(toolCallId);
      pendingSettlements.delete(toolCallId);
      if (pending !== undefined) {
        log[pending.level](LOG_SCOPE, pending.message, {
          ...pending.fields,
          // deny 路径从未执行（恒无 executionStartedAt）——此时全程只有
          // 排队/审批等待，durationMs 退化为全程时长，queueMs 缺席。
          durationMs: completedAt - (executionStartedAt ?? startedAt),
          ...(executionStartedAt !== undefined ?
            { queueMs: executionStartedAt - startedAt }
          : {}),
        });
      }
      return stepIndex;
    }
    default:
      return stepIndex;
  }
}
