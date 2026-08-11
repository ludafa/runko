/**
 * Renders a gated tool call's pending human-in-the-loop approval (docs/agent/single-ledger/tech.md §6) — driven directly by the tool part's own
 * `approval-requested` state (`part.toolCallId` *is* the approval's
 * `callId`, `part.approval.id` the same value again — no separate id space
 * to reconcile, unlike the retired `ApprovalTimelineEntry`/`callId` bridge
 * this replaces). Only ever rendered for a part in that one state
 * (`message-entry.tsx` intercepts it before it reaches `ToolCallCard`) —
 * once resolved (`approval-responded`/`output-denied`/`output-available`/
 * `output-error`), the *same* tool part renders via `ToolCallCard` instead,
 * which shows the resolution (including the deny reason) inline.
 *
 * 外壳用 ai-elements 的 `Confirmation`（Alert + 请求/接受/拒绝三态插槽）。三个
 * 按钮是 nimbo 自己的三值裁决（允许 / 会话内都允许 / 拒绝），比官方示例的两值多
 * 一档，所以按钮自己列——我们的裁决走 `POST .../approvals/:callId`，不是 useChat
 * 内置的 `addToolApprovalResponse` 通道。
 */
import { CheckCheckIcon, CheckIcon, Loader2Icon, XIcon } from 'lucide-react';

import {
  Confirmation,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import type { NimboToolPart } from '../timeline';
import { bashCommandFromInput, prettyJson, toolPartName } from '../timeline';

/** Only the one state this card ever renders (see file header) — narrowed so `part.input`/`part.approval.id` don't need an `undefined` check that can never actually happen for this state. */
export type PendingApprovalPart = Extract<
  NimboToolPart,
  { state: 'approval-requested' }
>;

/**
 * 工具名 → 人话动作。审批卡片的标题给非专家一句「agent 想做什么」，而不是甩一个
 * 裸工具名（`bash`）。未登记的工具回落到「调用 <toolName>」，此时不再另标工具名
 * tag（标题里已经有了）。新增内置工具时在这里补一行即可。
 */
const FRIENDLY_TOOL_ACTIONS: Record<string, string> = {
  bash: '运行命令',
  'write-file': '写入文件',
  'edit-file': '修改文件',
  'read-file': '读取文件',
  'list-dir': '查看目录',
  glob: '按名字找文件',
  grep: '搜索文件内容',
};

export function ApprovalCard({
  part,
  submitting,
  expired,
  onDecide,
}: {
  part: PendingApprovalPart;
  submitting: boolean;
  /** `useChatMessages`'s `locallyExpiredCallIds` (a 404 on submit — the server no longer has this pending) — not part of the tool part's own state, which has no "expired" concept. */
  expired: boolean;
  /** `'allow-session'` = 会话级授权（docs/terms.md §四）：放行本次并记住这次具体调用，本会话内相同调用后续不再弹卡片。 */
  onDecide: (behavior: 'allow' | 'allow-session' | 'deny') => void;
}) {
  const toolName = toolPartName(part);
  const knownAction = FRIENDLY_TOOL_ACTIONS[toolName];
  // 已登记工具：友好标题 +（右侧）小号工具名 tag 给开发者；未登记：标题里直接带工具名，不再另标 tag。
  const title = `agent 想${knownAction ?? `调用 ${toolName}`}，先确认一下`;
  const command = bashCommandFromInput(part.input);
  const status = expired ? 'expired' : 'pending';
  const spinner = (
    <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
  );

  return (
    <Confirmation
      approval={part.approval}
      state={part.state}
      data-testid="approval-card"
      data-status={status}
      className="mb-2"
    >
      <ConfirmationTitle className="flex flex-wrap items-center gap-2">
        <span className="text-foreground font-medium">{title}</span>
        {knownAction !== undefined && (
          <code className="text-muted-foreground font-mono text-xs">
            {toolName}
          </code>
        )}
        <Badge variant="secondary" className="ml-auto shrink-0">
          {expired ? '已失效' : '待审批'}
        </Badge>
      </ConfirmationTitle>

      <ConfirmationRequest>
        {/* 提示符是 `::before` 伪元素而不是真节点：用户十有八九会把这条命令复制走，
            真节点会连提示符一起进剪贴板（select-none 挡得住拖选，挡不住 Cmd+A）。 */}
        {command !== undefined ?
          <pre className="bg-muted text-foreground before:text-muted-foreground overflow-x-auto rounded-md px-2.5 py-2 font-mono text-xs leading-relaxed before:pr-2 before:content-['$']">
            {command}
          </pre>
        : <pre className="bg-muted text-foreground overflow-x-auto rounded-md px-2.5 py-2 font-mono text-xs leading-relaxed">
            {prettyJson(part.input)}
          </pre>
        }
        {expired && (
          <p className="text-muted-foreground mt-2 text-xs">
            已失效（超时或轮次已结束）
          </p>
        )}
      </ConfirmationRequest>

      {!expired && (
        <ConfirmationActions className="justify-start self-start">
          <Button
            size="sm"
            onClick={() => {
              onDecide('allow');
            }}
            disabled={submitting}
          >
            {submitting ?
              spinner
            : <CheckIcon className="size-3.5" aria-hidden="true" />}
            允许
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onDecide('allow-session');
            }}
            disabled={submitting}
            title="放行本次，并记住这次调用——本会话内相同调用不再询问"
          >
            {submitting ?
              spinner
            : <CheckCheckIcon className="size-3.5" aria-hidden="true" />}
            会话内都允许
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              onDecide('deny');
            }}
            disabled={submitting}
          >
            {submitting ?
              spinner
            : <XIcon className="size-3.5" aria-hidden="true" />}
            拒绝
          </Button>
        </ConfirmationActions>
      )}
    </Confirmation>
  );
}
