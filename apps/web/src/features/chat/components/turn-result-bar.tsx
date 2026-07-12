import type { Usage } from '@nimbo/core';

// Deliberately not `toLocaleString()`: keeps the rendered text deterministic
// across test/CI environments regardless of ICU data availability.
function formatCount(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

export function TurnResultBar({ usage }: { usage: Usage }) {
  const parts = [
    formatCount(usage.inputTokens) !== undefined &&
      `输入 ${formatCount(usage.inputTokens)}`,
    // 缓存命中的输入 token —— 展示在每轮里（cache miss 时为 0，也如实显示）
    formatCount(usage.cachedInputTokens) !== undefined &&
      `缓存命中 ${formatCount(usage.cachedInputTokens)}`,
    formatCount(usage.outputTokens) !== undefined &&
      `输出 ${formatCount(usage.outputTokens)}`,
    formatCount(usage.totalTokens) !== undefined &&
      `共计 ${formatCount(usage.totalTokens)} tokens`,
  ].filter((part): part is string => typeof part === 'string');

  return (
    <div
      data-testid="turn-result-bar"
      className="text-muted-foreground border-foreground/8 flex items-center justify-center gap-3 rounded-full border border-dashed px-3 py-1 text-[0.7rem]"
    >
      {parts.length > 0 ? parts.join(' · ') : '本轮结束'}
    </div>
  );
}
