// @ts-check
/// <reference lib="webworker" />
/**
 * 推送通知的 Service Worker（docs/tech/push-notification.md §7）。
 *
 * 它只做两件事：收到推送弹一条通知、点了通知把人送回对应会话。
 *
 * **刻意写成裸 JS 放 public/**（技术方案附录 B.1）：Vite 原样把 public/ 拷到站点
 * 根，dev 与 build 两种模式都直接可用，零新增构建配置。放弃类型检查的代价靠"把
 * 它做薄"来对冲——文案全部由服务端拼好，这里不做任何业务判断，每个字段读取都带
 * typeof 守卫，读不到就退化成兜底文案。
 *
 * **刻意不调任何 API**（附录 B.2）：生产环境下 web 与 API 是两个源，SW 发请求带的
 * 是站点 cookie，跨源 + cookie + SW 三者叠加会随浏览器策略静默失效，而这类失效
 * 最难发现。订阅换了 endpoint 由页面每次加载幂等重报兜底。
 */

const FALLBACK_TITLE = 'runko chat';
const FALLBACK_BODY = '有新动静。';
const FALLBACK_URL = '/chat';

/**
 * 从一个来路不明的值里读一个非空字符串字段。载荷是网络来的，形状不可信；
 * 读不到就返回 undefined，由调用处用兜底文案顶上。
 *
 * @param {unknown} source
 * @param {string} key
 * @param {number} maxLength
 * @returns {string | undefined}
 */
function readString(source, key, maxLength) {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const value = Reflect.get(source, key);
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value.length === 0 || value.length > maxLength) {
    return undefined;
  }
  return value;
}

/**
 * 读一个布尔字段。缺失/类型不对一律当 false——「挂住不消失」这类会改变打扰强度的
 * 开关，拿不准时取更克制的那一档。
 *
 * @param {unknown} source
 * @param {string} key
 * @returns {boolean}
 */
function readBoolean(source, key) {
  if (typeof source !== 'object' || source === null) {
    return false;
  }
  return Reflect.get(source, key) === true;
}

/** 服务端允许的三种裁决——白名单，不是"载荷里写啥就发啥"。 */
const BEHAVIORS = ['allow', 'allow-session', 'deny'];

/**
 * 读通知按钮数组。每一项必须齐全（id / title / 白名单内的 behavior），任何一项不
 * 合格就整条丢掉——按钮点下去是要改变系统状态的，宁可不显示，也不能显示一个
 * 点了会发出未知请求的按钮。
 *
 * @param {unknown} source
 * @returns {{id: string, title: string, behavior: string}[]}
 */
function readActions(source) {
  if (typeof source !== 'object' || source === null) {
    return [];
  }
  const raw = Reflect.get(source, 'actions');
  if (!Array.isArray(raw)) {
    return [];
  }
  const result = [];
  for (const item of raw) {
    const id = readString(item, 'id', 40);
    const title = readString(item, 'title', 40);
    const behavior = readString(item, 'behavior', 40);
    if (id === undefined || title === undefined) {
      continue;
    }
    if (behavior === undefined || !BEHAVIORS.includes(behavior)) {
      continue;
    }
    result.push({ id, title, behavior });
  }
  return result;
}

/**
 * 只接受站内相对路径。防的是「推送载荷里塞一个外站 URL，点通知就把人送出去」
 * ——虽然载荷只可能来自我们自己的服务端，但这个判断一行的事，不做没道理。
 *
 * @param {string | undefined} url
 * @returns {string}
 */
function safeUrl(url) {
  if (url === undefined) {
    return FALLBACK_URL;
  }
  return url.startsWith('/') && !url.startsWith('//') ? url : FALLBACK_URL;
}

self.addEventListener('install', () => {
  // 立刻接管，不等旧 SW 的所有页面关掉——这份 SW 没有缓存策略，新旧交替不会
  // 让页面拿到半新半旧的资源。
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    // 解不开就让 data 保持 null，下面全部走兜底文案——宁可弹一条模糊的，
    // 也不能一声不吭（收到推送必须弹通知，见 push-client.ts 的 userVisibleOnly）。
  }

  const title = readString(data, 'title', 200) ?? FALLBACK_TITLE;
  const body = readString(data, 'body', 500) ?? FALLBACK_BODY;
  const url = safeUrl(readString(data, 'url', 500));
  const tag = readString(data, 'tag', 200);
  const actions = readActions(data);
  const conversationId = readString(data, 'conversationId', 200);
  const callId = readString(data, 'callId', 200);
  /** 够不够直接在通知上裁决：三样齐了才行，缺一样就退化成"点开去页面上处理"。 */
  const decidable =
    actions.length > 0 && conversationId !== undefined && callId !== undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // `body` 一起存下来：点了「允许」之后的确认通知会把它原样带上，万一手滑
      // 也能立刻看见自己刚批准了什么（这是"通知里能直接放行命令"唯一的兜底）。
      data:
        decidable ? { url, conversationId, callId, actions, body } : { url },
      // 按钮：浏览器只渲染前 `Notification.maxActions` 个（Chrome 是 2），多的
      // **静默丢弃**——所以服务端已按优先级排好序（允许 / 拒绝 / 本会话都允许）。
      // Safari 完全不支持 actions，那里就只有"点开跳转"。
      ...(decidable ?
        { actions: actions.map((a) => ({ action: a.id, title: a.title })) }
      : {}),
      // 挂住不消失：通知停在屏幕上直到人动手（点开或划掉），不几秒就自己收走。
      // 只有「要审批 / agent 提问」两类是 true——服务端定的，见 PushPayload.sticky。
      //
      // 平台差异（别指望它到处都灵）：Chrome / Edge 桌面版认这个字段；Firefox 与
      // Safari 直接忽略；Android Chrome 也忽略。**macOS 上还多一层**：Chrome 走
      // 系统通知中心，横幅样式仍会几秒后自动隐藏——要真挂住，得在
      // 「系统设置 → 通知 → Google Chrome」里把提醒样式从「横幅」改成「提示」。
      requireInteraction: readBoolean(data, 'sticky'),
      // 同一标签的新通知**替换**旧的而不是堆叠（同一条会话连着三次审批，通知栏
      // 里始终只有一条）；`renotify` 让替换时仍然提醒一次，否则用户不会察觉。
      // 没有 tag 时 renotify 会被浏览器判为非法组合，故一起给或一起不给。
      ...(tag !== undefined ? { tag, renotify: true } : {}),
    }),
  );
});

/**
 * 结果反馈通知。带自己的 tag，免得替换掉别的会话的通知。
 *
 * `sticky` 分档很要紧：**成功**的反馈可以一闪而过（事情已经办成了），**失败**的
 * 必须挂住——它一闪而过的话，用户看到的就是"点了按钮什么都没发生"，而这恰恰是
 * 最难排查的一种故障。
 *
 * @param {string} title
 * @param {string} body
 * @param {string} tag
 * @param {boolean} sticky
 */
function toast(title, body, tag, sticky) {
  return self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    requireInteraction: sticky,
    data: { url: FALLBACK_URL },
  });
}

/**
 * 用户点了通知上的裁决按钮：直接把裁决发给服务端，不用打开页面。
 *
 * 请求走同源相对路径 + `credentials: 'include'`——SW 注册在站点根，`/api/*` 由
 * dev server 代理到 node-server，登录 cookie 自动带上。
 *
 * @param {{conversationId: string, callId: string, behavior: string, body: string, actionTitle: string}} input
 */
async function submitDecision(input) {
  const { conversationId, callId, behavior, body, actionTitle } = input;
  const endpoint =
    `/api/chat/conversations/${encodeURIComponent(conversationId)}` +
    `/approvals/${encodeURIComponent(callId)}`;
  console.info('[sw] 提交裁决', { endpoint, behavior });
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ behavior }),
    });
  } catch (error) {
    console.error('[sw] 裁决请求发不出去', error);
    await toast(
      '没能提交（网络错误）',
      `${body}\n点这条打开页面处理`,
      `decision-error:${conversationId}`,
      true,
    );
    return;
  }
  console.info('[sw] 裁决响应', response.status);
  if (response.status === 404) {
    // 这条审批已经不在了：超时自动拒绝了，或者别的标签页/设备刚处理过。
    await toast(
      '这条审批已经处理过了',
      `${body}\n（可能是等太久自动拒绝了）`,
      `decision:${conversationId}`,
      true,
    );
    return;
  }
  if (!response.ok) {
    // 401 在这里格外值得单独说：SW 的请求没带上登录态，光说"失败"会让人以为是
    // 服务端坏了，实际上重新登录一下就好。
    const hint =
      response.status === 401 ?
        '没登录（或登录过期）'
      : `HTTP ${String(response.status)}`;
    console.error('[sw] 裁决被拒', response.status);
    await toast(
      `没能提交：${hint}`,
      `${body}\n点这条打开页面处理`,
      `decision-error:${conversationId}`,
      true,
    );
    return;
  }
  // 确认里带上原正文（那条命令）——万一手滑点了「允许」，这是你立刻看见自己批了
  // 什么的唯一机会。
  await toast(`已${actionTitle}`, body, `decision:${conversationId}`, false);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const url = safeUrl(readString(data, 'url', 500));

  const actions = readActions(data);
  const conversationId = readString(data, 'conversationId', 200);
  const callId = readString(data, 'callId', 200);
  console.info('[sw] notificationclick', {
    action: event.action,
    hasActions: actions.length,
    conversationId,
    callId,
  });

  // 点的是某个按钮（`event.action` 是按钮 id；点通知主体时它是空串）。
  if (event.action) {
    const chosen = actions.find((a) => a.id === event.action);
    if (chosen !== undefined && conversationId && callId) {
      event.waitUntil(
        submitDecision({
          conversationId,
          callId,
          behavior: chosen.behavior,
          body: readString(data, 'body', 500) ?? '',
          actionTitle: chosen.title,
        }),
      );
      return;
    }
    // 按钮点了但配不上（不该发生）：不能静悄悄退化成"打开页面"，那样用户看到的
    // 就是"点了允许，结果只是跳了个页面"，完全猜不到发生了什么。挂一条说明。
    console.error('[sw] 按钮点了但数据配不上', {
      action: event.action,
      actionIds: actions.map((a) => a.id),
      conversationId,
      callId,
    });
    event.waitUntil(
      toast(
        '这个按钮没能用上',
        '已为你打开页面，在审批卡片上处理',
        `decision-error:${conversationId ?? 'unknown'}`,
        true,
      ),
    );
  } else if (actions.length > 0) {
    // 这条通知**是有按钮的**，但点击没带回按钮 id——多半是平台把按钮点击降级成了
    // 普通点击（macOS 的系统通知中心有这个行为）。同样不能装作无事发生。
    console.warn('[sw] 有按钮但 event.action 为空，平台可能降级了按钮点击');
  }

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // 复用已开着的窗口：focus 之后让页面自己路由过去。不用 openWindow 直接
      // 开新页，是因为整页重载会丢掉正在流的那一轮（SSE 连接断开重连、已渲染的
      // 时间线重建），而用户点通知恰恰常常是在一轮进行中。
      for (const client of windows) {
        await client.focus();
        client.postMessage({ type: 'push-navigate', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
