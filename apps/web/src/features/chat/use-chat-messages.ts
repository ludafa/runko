/**
 * The chat feature's core deliverable (docs/tech/chat-webapp.md §2.2b, the P12-4 rewrite,
 * carried over verbatim through the P13-5-4 UIMessage-ledger migration): turn
 * *execution* and *connection* are decoupled — `sendMessage` only fires
 * `POST .../messages` (starts the turn server-side, independent of any
 * request/response lifetime) and then (re)opens the resumable live tail
 * (`GET .../stream?after=<seq>`); the tail is *also* opened unconditionally
 * on mount, so a page refresh/HMR reload/tab restore reconnects to whatever
 * turn was still in flight before the reload, picking its remaining frames
 * up exactly where the last connection left off.
 *
 * `turnInProgressRef` is the hook's own belief about whether *this* conversation
 * currently has a turn running — seeded from `initialFrames` on mount (see
 * `lastFrameIsChunk` below) and flipped by the `MessageLedger`'s own
 * `onTurnEnd` callback (docs/tech/single-ledger.md §5 单-3's
 * turn-ending `message-metadata` chunk — `materialize.ts`'s file header) the
 * moment a turn actually concludes. It gates: (a) which of the two
 * `sendMessage` branches below runs (start a new turn vs. steer the
 * in-progress one — STEER-3B), (b) whether a tail that just ended (cleanly or
 * via error) should reconnect.
 *
 * ---- optimistic user echo (short-lived — this ticket's fix) ----
 *
 * `apps/node-server`'s `turn-runner.ts` now gives a turn-starting user message a
 * real wire position: `driveTurn` synthesizes and broadcasts it as this
 * turn's very first `MessageFrame`, strictly before anything else that turn
 * produces (`schemas/chat.ts`'s file header). `pendingUserEchoes`
 * (`sendMessage`'s new-turn branch only, never the steer branch, which
 * *does* get a real materialized entry straight away) is therefore only ever
 * a **short-lived** placeholder now, covering the brief window between
 * `sendMessage` firing the `POST` and that real `MessageFrame` actually
 * arriving over the tail — each one anchored to `messages.length` at the
 * moment it was sent (`timeline.ts`'s `buildRenderEntries` splices it back
 * into its sent-at position) and popped, FIFO, the instant `MessageLedger`
 * reports a `role === 'user'` `MessageFrame` (`ledgerRef`'s construction
 * below, `onUserMessage` — see `materialize.ts`'s `UserMessageListener` doc
 * comment for why *only* a `MessageFrame` pops one, never a steer message's
 * chunk-materialized entry). Because a turn can't even start until the
 * previous one's `onTurnEnd` has fired — which is necessarily *after* that
 * turn's own user-message echo was already popped — at most one echo is ever
 * pending at a time in the normal flow; `buildRenderEntries` still sorts
 * same-anchor echoes into ascending-id (send) order as a defensive fallback
 * (its own doc comment) in case a stale-closure race ever produces more than
 * one anyway.
 */
import type { NimboMessageMetadata, NimboUIMessage } from '@nimbo/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ChatApiError,
  postApprovalDecision,
  postChatMessage,
  postQuestionAnswer,
  streamConversationTail,
} from './api';
import { MessageLedger } from './materialize';
import type { ChatReplayFrame } from './schema';
import type { PendingUserEcho } from './timeline';

export type ChatTurnStatus = 'idle' | 'streaming' | 'error';

export interface UseChatMessagesResult {
  messages: NimboUIMessage[];
  /** Short-lived — popped, FIFO, once the real turn-start `MessageFrame` arrives (see file header) — render these interleaved with `messages` via `timeline.ts`'s `buildRenderEntries`. */
  pendingUserEchoes: PendingUserEcho[];
  status: ChatTurnStatus;
  error: string | undefined;
  /** True from `sendMessage` until the first frame of that turn arrives — docs/tech/chat-webapp.md §2.3's "沙盒恢复中…" gate. */
  awaitingFirstEvent: boolean;
  sendMessage: (text: string) => void;
  cancel: () => void;
  /**
   * `callId`s with an in-flight `POST .../approvals/:callId` or
   * `.../questions/:callId` — cards use this to disable their own
   * buttons/show a spinner and block a second submit for the same `callId`
   * while one is already outstanding.
   */
  submittingCallIds: ReadonlySet<string>;
  /**
   * `submitApproval`/`submitAnswer` got a `404` back for these `callId`s —
   * the server no longer has them pending (already timed out, or the turn
   * already ended). Fed into the tool-part cards (via `TimelineView`/the
   * page) to render the matching part as expired instead of pending.
   */
  locallyExpiredCallIds: ReadonlySet<string>;
  /** Resolve a pending tool-call approval (docs/tech/single-ledger.md §6) — result arrives back over the tail as the matching part's `tool-approval-response` chunk, not from this call's own resolution ("不做乐观翻转"). */
  submitApproval: (
    callId: string,
    behavior: 'allow' | 'allow-session' | 'deny',
  ) => void;
  /** Answer a pending `ask-user` question — same "wire is the only source of truth" posture as `submitApproval`. */
  submitAnswer: (callId: string, answer: string) => void;
}

/** Exponential backoff for tail reconnects — 1s, 2s, 4s, 8s, 16s, then give up quietly. */
const TAIL_RECONNECT_BASE_DELAY_MS = 1000;
const TAIL_RECONNECT_MAX_ATTEMPTS = 5;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * `finalizeTurnPersistence` (`apps/node-server`'s `turn-runner.ts`) only ever GCs a
 * turn's `kind = 'chunk'` rows *after* it finishes gracefully — a cleanly-
 * completed turn's history therefore ends in `MessageFrame`s only, while an
 * in-progress or crashed one's tail end is still `ChunkEnvelope`s (never
 * finalized, nothing to GC yet). This is a structural invariant of the
 * server's own persistence, not a heuristic.
 */
function lastFrameIsChunk(frames: readonly ChatReplayFrame[]): boolean {
  const last = frames.at(-1);
  return last !== undefined && !('message' in last);
}

function describeError(error: unknown): string {
  if (error instanceof ChatApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function statusFromTurnEnd(metadata: NimboMessageMetadata): ChatTurnStatus {
  return metadata.status === 'completed' ? 'idle' : 'error';
}

function errorFromTurnEnd(metadata: NimboMessageMetadata): string | undefined {
  return metadata.status === 'completed' ? undefined : metadata.error?.message;
}

export function useChatMessages(
  conversationId: string,
  initialFrames: ChatReplayFrame[],
): UseChatMessagesResult {
  const [messages, setMessages] = useState<NimboUIMessage[]>([]);
  const [pendingUserEchoes, setPendingUserEchoes] = useState<PendingUserEcho[]>(
    [],
  );
  const initialTurnInProgress = lastFrameIsChunk(initialFrames);
  const [status, setStatus] = useState<ChatTurnStatus>(
    initialTurnInProgress ? 'streaming' : 'idle',
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [awaitingFirstEvent, setAwaitingFirstEvent] = useState(false);
  const [submittingCallIds, setSubmittingCallIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [locallyExpiredCallIds, setLocallyExpiredCallIds] = useState<
    ReadonlySet<string>
  >(new Set());

  const turnInProgressRef = useRef(initialTurnInProgress);
  const nextEchoIdRef = useRef(0);
  const tailAbortRef = useRef<AbortController | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Only seq'd (persisted) frames are dedup-tracked (docs/tech/single-ledger.md §5 单-3) — an
  // ephemeral `ChunkEnvelope` (no `seq`) has no `seq` to dedupe by, and
  // doesn't need one (it's never redelivered by a replay/reconnect the way a
  // persisted frame can be).
  const seenSeqs = useRef(
    new Set(
      initialFrames
        .map((frame) => frame.seq)
        .filter((seq): seq is number => seq !== undefined),
    ),
  );
  const lastSeqRef = useRef(
    initialFrames.reduce(
      (max, frame) =>
        frame.seq !== undefined ? Math.max(max, frame.seq) : max,
      0,
    ),
  );

  // One `MessageLedger` instance for this hook's whole lifetime (mirrors
  // `initialFrames` being consumed exactly once — the parent remounts this
  // hook fresh, `key={conversationId}`, on a conversation change, same as before this
  // migration). Constructed *and* seeded inside an effect, not during render:
  // some ledger paths (a steer message, or a standalone turn-end
  // `message-metadata` chunk) call their `onChange`/`onTurnEnd` callbacks
  // *synchronously* — unlike the `readUIMessageStream()`-driven path, which
  // only ever resolves asynchronously via a microtask — and those callbacks
  // close over `turnInProgressRef`/`reconnectAttemptRef` (`react-hooks/refs`
  // flags a ref read inside a closure handed to a call that happens during
  // render, since it can't prove `new MessageLedger(...)`'s constructor
  // won't invoke it synchronously). `initializedRef` survives React
  // StrictMode's deliberate mount→cleanup→mount double-invoke (the component
  // itself is never actually unmounted in between, so the ref isn't reset)
  // — without it, the second invocation would construct a second ledger and
  // re-feed the same history. Declared *before* the tail-opening effect below
  // so this (synchronous) bookkeeping is settled first; `[]` deps is
  // intentional, not a lint oversight: this hook instance's `initialFrames`/
  // `conversationId` are fixed for its whole lifetime (the parent remounts fresh,
  // `key={conversationId}`, on a conversation change — `chat-conversation.tsx`).
  const ledgerRef = useRef<MessageLedger | undefined>(undefined);
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const ledger = new MessageLedger(
      (nextMessages) => {
        setMessages(nextMessages);
      },
      (metadata) => {
        turnInProgressRef.current = false;
        reconnectAttemptRef.current = 0;
        setStatus(statusFromTurnEnd(metadata));
        setError(errorFromTurnEnd(metadata));
      },
      () => {
        // The real turn-start user message just landed (see file header) —
        // pop the oldest pending echo, FIFO. Guarded so an already-empty
        // queue is a true no-op (returning the same array reference bails
        // React out of a re-render) rather than a harmless-but-wasteful
        // `setState` call — this branch is reachable on mount replay, where
        // `pendingUserEchoes` is always still empty.
        setPendingUserEchoes((prev) =>
          prev.length === 0 ? prev : prev.slice(1),
        );
      },
    );
    ledgerRef.current = ledger;
    for (const frame of initialFrames) ledger.applyFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initialFrames` is this hook instance's fixed seed, not a reactive prop (see comment above)
  }, []);

  const applyFrame = useCallback((frame: ChatReplayFrame) => {
    const seq = frame.seq;
    if (seq !== undefined) {
      if (seenSeqs.current.has(seq)) return; // dedupe: tail reconnect overlap / re-delivery safety net
      seenSeqs.current.add(seq);
      lastSeqRef.current = Math.max(lastSeqRef.current, seq);
    }
    setAwaitingFirstEvent(false);
    // `ledgerRef.current` is only ever `undefined` in the vanishingly brief
    // window between mount and the construction effect above running — the
    // tail's own mount effect is declared after it (same-phase passive
    // effects run in declaration order), so by the time anything actually
    // calls this, it's always set. Guarded rather than asserted non-null.
    ledgerRef.current?.applyFrame(frame);
  }, []);

  // `openTailRef` always holds *this* render's `startTail` closure (fresh
  // `conversationId`/`applyFrame` captured every render, assigned unconditionally
  // below — the standard "ref to latest callback" idiom for a function that
  // needs to schedule a call to its own latest version from a `setTimeout`
  // without a lint-flagged self-reference-before-declaration on the `const`
  // it's assigned to). `openTail` itself is the stable (never-recreated)
  // handle every caller (the mount effect, `sendMessage`) actually uses.
  const openTailRef = useRef<() => void>(() => undefined);

  function startTail(): void {
    tailAbortRef.current?.abort();
    const controller = new AbortController();
    tailAbortRef.current = controller;

    function maybeReconnect(): void {
      if (controller.signal.aborted) return; // intentionally stopped (unmount/cancel/superseded) — never auto-reconnect
      if (!turnInProgressRef.current) return; // turn already concluded — quiet, nothing to catch up on
      if (reconnectAttemptRef.current >= TAIL_RECONNECT_MAX_ATTEMPTS) return; // give up quietly
      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current += 1;
      const delay = TAIL_RECONNECT_BASE_DELAY_MS * 2 ** attempt;
      reconnectTimeoutRef.current = setTimeout(() => {
        openTailRef.current();
      }, delay);
    }

    streamConversationTail(
      conversationId,
      lastSeqRef.current,
      { onFrame: applyFrame },
      controller.signal,
    )
      .then(() => {
        maybeReconnect(); // the tail closed — could be a finished turn (no-op above) or a server hiccup
      })
      .catch((tailError: unknown) => {
        if (isAbortError(tailError)) return; // intentional cancel/unmount/supersede, not a disconnect
        maybeReconnect();
      });
  }

  // Refs may only be written outside of render (event handlers/effects, not
  // render itself) — this syncs `openTailRef` to *this* render's `startTail`
  // after every commit (no dependency array), always ahead of the
  // mount/reconnect effect below (same-phase passive effects run in
  // declaration order).
  useEffect(() => {
    openTailRef.current = startTail;
  });

  const openTail = useCallback(() => {
    openTailRef.current();
  }, []);

  useEffect(() => {
    reconnectAttemptRef.current = 0;
    openTail();
    return () => {
      tailAbortRef.current?.abort();
      if (reconnectTimeoutRef.current !== undefined) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = undefined;
      }
    };
  }, [conversationId, openTail]);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      if (turnInProgressRef.current) {
        // Steer the in-progress turn (STEER-3B) — see file header. No
        // optimistic echo (it gets a real materialized entry, unlike a
        // new-turn send) and no tail to (re)open (the one already open for
        // this turn keeps delivering, including the injected user message).
        // A failure here doesn't touch `status`/`turnInProgressRef`: the turn
        // itself is still running fine regardless of whether this particular
        // steer landed.
        postChatMessage(conversationId, trimmed).catch((postError: unknown) => {
          setError(describeError(postError));
        });
        return;
      }

      nextEchoIdRef.current += 1;
      const echoId = nextEchoIdRef.current;
      setPendingUserEchoes((prev) => [
        ...prev,
        { id: echoId, text: trimmed, afterMessageCount: messages.length },
      ]);
      setStatus('streaming');
      setError(undefined);
      setAwaitingFirstEvent(true);
      turnInProgressRef.current = true;
      reconnectAttemptRef.current = 0;

      postChatMessage(conversationId, trimmed)
        .then(() => {
          // The turn is now running server-side, independent of this
          // request — (re)connect the tail to observe it. A prior tail, if
          // any, has necessarily already ended by now (`turnInProgressRef`
          // gated the guard above), so this can't race an existing live
          // connection for the *previous* turn.
          openTail();
        })
        .catch((postError: unknown) => {
          turnInProgressRef.current = false;
          setAwaitingFirstEvent(false);
          setStatus('error');
          setError(describeError(postError));
          // The turn never actually started — undo the optimistic echo.
          setPendingUserEchoes((prev) =>
            prev.filter((echo) => echo.id !== echoId),
          );
        });
    },
    [conversationId, openTail, messages.length],
  );

  const cancel = useCallback(() => {
    tailAbortRef.current?.abort();
    if (reconnectTimeoutRef.current !== undefined) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }
    setStatus('idle');
  }, []);

  const markSubmitting = useCallback((callId: string) => {
    setSubmittingCallIds((prev) => new Set(prev).add(callId));
  }, []);

  const clearSubmitting = useCallback((callId: string) => {
    setSubmittingCallIds((prev) => {
      if (!prev.has(callId)) return prev;
      const next = new Set(prev);
      next.delete(callId);
      return next;
    });
  }, []);

  /**
   * `POST .../approvals/:callId` / `.../questions/:callId` (docs/tech/single-ledger.md §6): both
   * `submitApproval` and `submitAnswer` below funnel through this — mark
   * `callId` submitting, fire the request, and on failure either flag it
   * `locallyExpiredCallIds` (a `404`: the server no longer has it pending) or
   * surface it via the hook's own `error` (anything else — the part stays
   * pending, retryable). The *success* path deliberately does nothing to
   * `messages`: the decision's real effect only lands once the matching
   * `tool-approval-response` chunk (or the `ask-user` part's own
   * `output-available`) arrives over the tail ("不做乐观翻转——多 tab 一致性
   * 靠事件").
   */
  const submitDecision = useCallback(
    (callId: string, request: () => Promise<void>) => {
      if (submittingCallIds.has(callId)) return; // one in flight per callId — the card also disables its own button, this is defense in depth
      markSubmitting(callId);
      request()
        .catch((requestError: unknown) => {
          if (
            requestError instanceof ChatApiError &&
            requestError.status === 404
          ) {
            setLocallyExpiredCallIds((prev) => new Set(prev).add(callId));
            return;
          }
          setError(describeError(requestError));
        })
        .finally(() => {
          clearSubmitting(callId);
        });
    },
    [submittingCallIds, markSubmitting, clearSubmitting],
  );

  const submitApproval = useCallback(
    (callId: string, behavior: 'allow' | 'allow-session' | 'deny') => {
      submitDecision(callId, () =>
        postApprovalDecision(conversationId, callId, { behavior }),
      );
    },
    [conversationId, submitDecision],
  );

  const submitAnswer = useCallback(
    (callId: string, answer: string) => {
      const trimmed = answer.trim();
      if (trimmed.length === 0) return;
      submitDecision(callId, () =>
        postQuestionAnswer(conversationId, callId, trimmed),
      );
    },
    [conversationId, submitDecision],
  );

  return useMemo(
    () => ({
      messages,
      pendingUserEchoes,
      status,
      error,
      awaitingFirstEvent,
      sendMessage,
      cancel,
      submittingCallIds,
      locallyExpiredCallIds,
      submitApproval,
      submitAnswer,
    }),
    [
      messages,
      pendingUserEchoes,
      status,
      error,
      awaitingFirstEvent,
      sendMessage,
      cancel,
      submittingCallIds,
      locallyExpiredCallIds,
      submitApproval,
      submitAnswer,
    ],
  );
}
