import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// `@testing-library/react`'s own auto-cleanup only self-registers against a
// *global* `afterEach` (checked at import time) — this project's tests
// import `afterEach` from `vitest` explicitly rather than enabling
// `test.globals`, so it never fires on its own; without this, every test in
// a file accumulates previous tests' rendered DOM trees, breaking any query
// that expects a single match.
afterEach(() => {
  cleanup();
});

// jsdom has no layout engine, so it doesn't implement `ResizeObserver` at all
// (not even a no-op) — `use-stick-to-bottom` (chat/components/conversation.tsx)
// needs one to observe the scroll container. A no-op stub is all tests need:
// nothing in this suite asserts on actual scroll-position behavior.
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= NoopResizeObserver;

// 同理，jsdom 没有 `matchMedia`（它属于 CSSOM View，jsdom 未实现）。shadcn
// `Sidebar` 的 `useIsMobile`（hooks/use-mobile.ts）用它订阅断点，缺了它整个
// ChatLayout 一挂载就抛。这个 stub 恒答「不匹配」= 桌面档，正是这套用例要断言的
// 那一档（移动端侧栏走 Sheet，是另一条分支，本套件不覆盖）。
globalThis.matchMedia ??= (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
});

// 同理，jsdom 没有 Web Animations API：base-ui 的 ScrollArea.Viewport
// （components/ui/scroll-area.tsx）在 requestAnimationFrame 之后调用
// `viewport.getAnimations()` 判断滚动动画是否还在跑，缺了它会在测试**结束之后**
// 从定时器里抛未捕获异常——用例本身全绿，vitest 却以 1 退出。返回空数组即「无
// 动画进行中」，与本套件不断言滚动行为的前提一致。
Element.prototype.getAnimations ??= () => [];

// 同理，ProseMirror（[composer](../../../../docs/terms.md) 输入区的底层，经 tiptap
// ——docs/app/composer-skill-mention/tech.md §2.4）需要几个 CSSOM View 的方法来做光标
// 与选区的坐标换算。jsdom 没有布局引擎，这几个要么缺失、要么只在 Element 上有：
//
// - `Range.getClientRects` / `Range.getBoundingClientRect`：ProseMirror 每次
//   处理输入都要问「当前选区在屏幕上哪儿」。**缺了它连打一个字都会抛**，测试里
//   表现为「onSend 一次都没被调用」而不是断言失败，很难往这上面猜。
// - `document.elementFromPoint`：ProseMirror 用它做命中测试。
//
// 全部返回「零尺寸 / 无元素」——本套件断言的是键位分流与文本内容，不涉及任何
// 真实坐标；有一个不抛的实现就够了。
const emptyRect: DOMRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({}),
};

Range.prototype.getClientRects ??= () =>
  Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => emptyRect;
document.elementFromPoint ??= () => null;
