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
