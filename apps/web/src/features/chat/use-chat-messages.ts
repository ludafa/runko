/**
 * The chat feature's core deliverable (docs/08 §2.2b, the P12-4 rewrite):
 * turn *execution* and *connection* are decoupled — `sendMessage` only fires
 * `POST .../messages` (starts the turn server-side, independent of any
 * request/response lifetime) and then (re)opens the resumable live tail
 * (`GET .../stream?after=<seq>`); the tail is *also* opened unconditionally
 * on mount, so a page refresh/HMR reload/tab restore reconnects to whatever
 * turn was still in flight before the reload, picking its remaining events
 * up exactly where the last connection left off. This replaces the old
 * design's one-shot `POST` + inline SSE body (which died the instant the
 * client disconnected, taking the rest of the turn's visibility with it —
 * the turn itself kept running server-side regardless, but nothing was
 * listening anymore).
 *
 * `turnInProgressRef` is the hook's own belief about whether *this* session
 * currently has a turn running — seeded from `initialEnvelopes` on mount
 * (true iff the last persisted envelope isn't a terminal `turn.result`/
 * `turn.failed`, i.e. the turn was still going when the page was last torn
 * down) and flipped by `applyEnvelope` the moment either terminal event
 * arrives. It gates: (a) which of the two `sendMessage` branches below runs
 * (start a new turn vs. steer the in-progress one — STEER-3B), (b) whether a
 * tail that just ended (cleanly or via error) should reconnect (docs/08
 * §2.2b: "tail 断开时，若本轮尚未见 turn.result/turn.failed 就带
 * after=lastSeq 重开（指数退避、限次）").
 *
 * Optimistic user echo + dedup (docs/08 §2.2 "契约细化" #1), new-turn path
 * only: the server echoes the user's own text back as a real `user.message`
 * envelope (first event of the turn it kicks off, replayable from `GET
 * events`/the tail's replay), but a network round-trip before the user's own
 * message appears reads as laggy. `sendMessage` still inserts a local,
 * client-only `optimisticMessages` entry the instant it's called (zero
 * latency); `applyEnvelope` dequeues the oldest one — FIFO, since only one
 * turn is ever started this way at a time (`turnInProgressRef` blocks a
 * second new-turn send while one is in flight) — the moment the matching
 * server `user.message` envelope arrives, in the very same state update that
 * adds the confirmed envelope to `envelopes`. React batches both `setState`
 * calls from one `applyEnvelope` call into a single re-render, so the
 * optimistic bubble is never visibly duplicated with the confirmed one.
 *
 * Steering an in-progress turn (STEER-3B, docs/08 §2.2 "契约细化" #3): the
 * composer is no longer disabled while `status === 'streaming'` — a send in
 * that state takes the *other* `sendMessage` branch, which is just the same
 * `POST .../messages` (the server tells `'started'` and `'steered'` apart
 * itself, injecting into the in-progress turn via `Session.steer()`) with no
 * optimistic bubble and no new tail to open: there's nothing to reconcile
 * against, because a steered message never gets a `user.message` echo — its
 * one persisted, rendered record is the `user_message` `SessionItem` nimbo's
 * loop produces at its real injection point, which arrives over the tail
 * that's already open for this turn like any other item.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ChatApiError,
  postApprovalDecision,
  postChatMessage,
  postQuestionAnswer,
  streamSessionTail,
} from './api';
import type { ChatStreamEnvelope, TurnRunnerFailedEvent } from './schema';

export type ChatTurnStatus = 'idle' | 'streaming' | 'error';

export interface OptimisticUserMessage {
  id: number;
  text: string;
}

export interface UseChatMessagesResult {
  envelopes: ChatStreamEnvelope[];
  /** Not yet confirmed by a server `user.message` envelope — render these after `envelopes`' own timeline. */
  optimisticMessages: OptimisticUserMessage[];
  status: ChatTurnStatus;
  error: string | undefined;
  /** True from `sendMessage` until the first envelope of that turn arrives — docs/08 §2.3's "沙盒恢复中…" gate. */
  awaitingFirstEvent: boolean;
  sendMessage: (text: string) => void;
  cancel: () => void;
  /**
   * `callId`s with an in-flight `POST .../approvals/:callId` or
   * `.../questions/:callId` (docs/08 §2.2c（审批链）) — cards use this to
   * disable their own buttons/show a spinner and block a second submit for
   * the same `callId` while one is already outstanding.
   */
  submittingCallIds: ReadonlySet<string>;
  /**
   * `submitApproval`/`submitAnswer` got a `404` back for these `callId`s —
   * the server no longer has them pending (already timed out, or the turn
   * already ended) even though no `approval.resolved`/`question.answered`
   * ever reached this client. Fed into `buildTimeline` (via
   * `TimelineView`/the page) to fold the matching entry into `'expired'` —
   * see `timeline.ts`'s `BuildTimelineOptions`.
   */
  locallyExpiredCallIds: ReadonlySet<string>;
  /** Resolve a pending `bash` (or any gated tool) approval — result arrives back over the tail as `approval.resolved`, not from this call's own resolution (docs/08 §2.2c（审批链）: "不做乐观翻转"). */
  submitApproval: (callId: string, behavior: 'allow' | 'deny') => void;
  /** Answer a pending `ask_user` question — same "wire event is the only source of truth" posture as `submitApproval`. */
  submitAnswer: (callId: string, answer: string) => void;
}

/** Exponential backoff for tail reconnects (docs/08 §2.2b "指数退避、限次") — 1s, 2s, 4s, 8s, 16s, then give up quietly (the DB-only-recovery trade-off the same section documents for a crashed turn-runner process). */
const TAIL_RECONNECT_BASE_DELAY_MS = 1000;
const TAIL_RECONNECT_MAX_ATTEMPTS = 5;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** `turn-runner.ts`'s own flat sentinel (`code`+`message`, no nested `error`) — see `schema.ts`'s `turnRunnerFailedEventSchema`. A mid-stream `SessionEvent` `turn.failed` (nested `error: NimboError`) is *not* this — that one still completes normally into a following `turn.result`. */
function isTurnRunnerFailure(
  event: ChatStreamEnvelope['event'],
): event is TurnRunnerFailedEvent {
  return event.type === 'turn.failed' && !('error' in event);
}

function isTerminalEnvelope(envelope: ChatStreamEnvelope): boolean {
  return (
    envelope.event.type === 'turn.result' ||
    envelope.event.type === 'turn.failed'
  );
}

function maxSeq(envelopes: readonly ChatStreamEnvelope[]): number {
  let max = 0;
  for (const envelope of envelopes) max = Math.max(max, envelope.seq);
  return max;
}

function describeError(error: unknown): string {
  if (error instanceof ChatApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useChatMessages(
  sessionId: string,
  initialEnvelopes: ChatStreamEnvelope[],
): UseChatMessagesResult {
  const [envelopes, setEnvelopes] =
    useState<ChatStreamEnvelope[]>(initialEnvelopes);
  const [optimisticMessages, setOptimisticMessages] = useState<
    OptimisticUserMessage[]
  >([]);
  const lastInitialEnvelope = initialEnvelopes.at(-1);
  const initialTurnInProgress =
    lastInitialEnvelope !== undefined &&
    !isTerminalEnvelope(lastInitialEnvelope);
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

  const seenSeqs = useRef(
    new Set(initialEnvelopes.map((envelope) => envelope.seq)),
  );
  const lastSeqRef = useRef(maxSeq(initialEnvelopes));
  const turnInProgressRef = useRef(initialTurnInProgress);
  const nextOptimisticIdRef = useRef(0);
  const tailAbortRef = useRef<AbortController | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const applyEnvelope = useCallback((envelope: ChatStreamEnvelope) => {
    if (seenSeqs.current.has(envelope.seq)) return; // dedupe: tail reconnect overlap / re-delivery safety net
    seenSeqs.current.add(envelope.seq);
    lastSeqRef.current = Math.max(lastSeqRef.current, envelope.seq);
    setAwaitingFirstEvent(false);

    if (envelope.event.type === 'user.message') {
      // FIFO dequeue: only ever one message in flight, so the oldest pending
      // optimistic entry is always the one this confirms — see file header.
      setOptimisticMessages((prev) => prev.slice(1));
    }

    if (envelope.event.type === 'turn.result') {
      turnInProgressRef.current = false;
      reconnectAttemptRef.current = 0;
      setStatus('idle');
    } else if (isTurnRunnerFailure(envelope.event)) {
      turnInProgressRef.current = false;
      reconnectAttemptRef.current = 0;
      setStatus('error');
      setError(envelope.event.message);
    }

    setEnvelopes((prev) => [...prev, envelope].sort((a, b) => a.seq - b.seq));
  }, []);

  // `openTailRef` always holds *this* render's `startTail` closure (fresh
  // `sessionId`/`applyEnvelope` captured every render, assigned unconditionally
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
      if (reconnectAttemptRef.current >= TAIL_RECONNECT_MAX_ATTEMPTS) return; // give up quietly — docs/08 §2.2b's documented v1 trade-off
      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current += 1;
      const delay = TAIL_RECONNECT_BASE_DELAY_MS * 2 ** attempt;
      reconnectTimeoutRef.current = setTimeout(() => {
        openTailRef.current();
      }, delay);
    }

    streamSessionTail(
      sessionId,
      lastSeqRef.current,
      { onEnvelope: applyEnvelope },
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
  }, [sessionId, openTail]);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      if (turnInProgressRef.current) {
        // Steer the in-progress turn (STEER-3B) — see file header. No
        // optimistic bubble (nothing to reconcile it against — a steered
        // message never gets a `user.message` echo) and no tail to (re)open
        // (the one already open for this turn keeps delivering, including
        // the `user_message` item this produces). A failure here doesn't
        // touch `status`/`turnInProgressRef`: the turn itself is still
        // running fine regardless of whether this particular steer landed.
        postChatMessage(sessionId, trimmed).catch((postError: unknown) => {
          setError(describeError(postError));
        });
        return;
      }

      nextOptimisticIdRef.current += 1;
      const optimisticId = nextOptimisticIdRef.current;
      setOptimisticMessages((prev) => [
        ...prev,
        { id: optimisticId, text: trimmed },
      ]);
      setStatus('streaming');
      setError(undefined);
      setAwaitingFirstEvent(true);
      turnInProgressRef.current = true;
      reconnectAttemptRef.current = 0;

      postChatMessage(sessionId, trimmed)
        .then(() => {
          // The turn is now running server-side, independent of this
          // request — (re)connect the tail to observe it (docs/08 §2.2b).
          // A prior tail, if any, has necessarily already ended by now
          // (`turnInProgressRef` gated the guard above), so this can't race
          // an existing live connection for the *previous* turn.
          openTail();
        })
        .catch((postError: unknown) => {
          turnInProgressRef.current = false;
          setAwaitingFirstEvent(false);
          setStatus('error');
          setError(describeError(postError));
          // The turn never actually started — undo the optimistic bubble.
          setOptimisticMessages((prev) =>
            prev.filter((message) => message.id !== optimisticId),
          );
        });
    },
    [sessionId, openTail],
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
   * `POST .../approvals/:callId` / `.../questions/:callId` (docs/08
   * §2.2c（审批链）): both `submitApproval` and `submitAnswer` below funnel
   * through this — mark `callId` submitting, fire the request, and on
   * failure either flag it `locallyExpiredCallIds` (a `404`: the server no
   * longer has it pending) or surface it via the hook's own `error` (
   * anything else — the entry stays `'pending'`, retryable). The *success*
   * path deliberately does nothing to `envelopes`/timeline state: the
   * decision's real effect only lands once `approval.resolved`/
   * `question.answered` arrives over the tail (docs/08 §2.2c（审批链）:
   * "不做乐观翻转——多 tab 一致性靠事件").
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
    (callId: string, behavior: 'allow' | 'deny') => {
      submitDecision(callId, () =>
        postApprovalDecision(sessionId, callId, { behavior }),
      );
    },
    [sessionId, submitDecision],
  );

  const submitAnswer = useCallback(
    (callId: string, answer: string) => {
      const trimmed = answer.trim();
      if (trimmed.length === 0) return;
      submitDecision(callId, () =>
        postQuestionAnswer(sessionId, callId, trimmed),
      );
    },
    [sessionId, submitDecision],
  );

  return useMemo(
    () => ({
      envelopes,
      optimisticMessages,
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
      envelopes,
      optimisticMessages,
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
