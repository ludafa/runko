/**
 * 铃铛的状态机（docs/tech/push-notification.md §7）。
 *
 * 六个状态，界面据此决定渲不渲染、渲成什么样：
 *
 * | 状态 | 含义 | 铃铛 |
 * |---|---|---|
 * | `loading` | 还在问服务端「推送开没开」 | 不渲染 |
 * | `disabled` | 服务端没配 VAPID | 不渲染（用户看不出有这个功能） |
 * | `unsupported` | 这台设备的浏览器不支持 | 灰掉 + 提示 |
 * | `off` | 支持，但这台设备还没开 | 空心，可点 |
 * | `on` | 已开启 | 实心，可点（关掉） |
 * | `blocked` | 浏览器层面被拒 | 划掉 + 指引去浏览器设置 |
 *
 * **绝不主动弹权限框**：一进页面就问「能不能给你发通知」是最招人烦的做法，
 * Chrome 还会因此惩罚站点。只有用户点铃铛才 `requestPermission()`。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchPushConfig } from './api';
import {
  currentPermission,
  ensureServiceWorker,
  getExistingSubscription,
  isPushSupported,
  looksLikeIos,
  subscribe,
  syncSubscription,
  unsubscribe,
} from './push-client';

export type PushToggleState =
  'loading' | 'disabled' | 'unsupported' | 'off' | 'on' | 'blocked';

export interface PushToggle {
  state: PushToggleState;
  /** 正在处理一次开/关（按钮该禁用）。与 `state` 正交：处理期间 `state` 保持旧值，不闪。 */
  busy: boolean;
  /** 上一次操作的失败原因，成功即清空。 */
  error: string | undefined;
  /** 不支持时的一句人话提示（iOS 与其它浏览器措辞不同）。 */
  hint: string | undefined;
  toggle: () => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function usePushToggle(): PushToggle {
  const [state, setState] = useState<PushToggleState>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** VAPID 公钥，`subscribe` 时要用；`disabled` 状态下恒为 undefined。 */
  const publicKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      try {
        const config = await fetchPushConfig(controller.signal);
        if (cancelled) return;
        if (!config.enabled || config.publicKey === null) {
          setState('disabled');
          return;
        }
        publicKeyRef.current = config.publicKey;

        if (!isPushSupported()) {
          setState('unsupported');
          return;
        }
        if (currentPermission() === 'denied') {
          setState('blocked');
          return;
        }

        const registration = await ensureServiceWorker();
        const existing = await getExistingSubscription(registration);
        if (cancelled) return;
        if (existing === null) {
          setState('off');
          return;
        }
        // 幂等重上报（技术方案 §3.1）：浏览器可能悄悄换过 endpoint，页面每次加载
        // 补一次，是我们兜住 `pushsubscriptionchange` 的全部手段。
        const synced = await syncSubscription(existing);
        if (cancelled) return;
        setState(synced ? 'on' : 'off');
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        // 问不到配置就当没这个功能——比顶着一个点不动的铃铛强。
        setState('disabled');
        setError(describeError(err));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const enable = useCallback(async () => {
    const publicKey = publicKeyRef.current;
    if (publicKey === undefined) return;
    const permission = await Notification.requestPermission();
    if (permission === 'denied') {
      setState('blocked');
      return;
    }
    if (permission !== 'granted') return; // 用户直接关掉了弹框：留在 off，不报错
    const registration = await ensureServiceWorker();
    const existing = await getExistingSubscription(registration);
    const subscription = existing ?? (await subscribe(registration, publicKey));
    const synced = await syncSubscription(subscription);
    setState(synced ? 'on' : 'off');
  }, []);

  const disable = useCallback(async () => {
    const registration = await ensureServiceWorker();
    const existing = await getExistingSubscription(registration);
    if (existing !== null) await unsubscribe(existing);
    setState('off');
  }, []);

  const toggle = useCallback(() => {
    if (busy) return;
    if (state !== 'off' && state !== 'on') return;
    setBusy(true);
    setError(undefined);
    void (state === 'off' ? enable() : disable())
      .catch((err: unknown) => {
        setError(describeError(err));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [busy, state, enable, disable]);

  return {
    state,
    busy,
    error,
    hint:
      state === 'unsupported' ?
        looksLikeIos() ?
          'iPhone / iPad 的 Safari 不支持网页推送（需要把网页装成独立应用，本项目没做）。在电脑上开启即可。'
        : '这个浏览器不支持网页推送。'
      : state === 'blocked' ?
        '通知权限被浏览器拒了。到浏览器的站点设置里把「通知」改成允许，再刷新页面。'
      : undefined,
    toggle,
  };
}
