/**
 * 设置页——目前只有一项：[直播流](../../../../docs/terms.md)走 SSE 还是 WebSocket。
 *
 * 为什么给用户一个开关，而不是自己挑一条（见 docs/ingress/features/ws-stream.md）：
 * 两条通道推的内容一模一样，差别在连接形态，而哪种更合适要在真环境里对照着看——
 * 同一套集群、同一个账号，切一下就能比。
 *
 * 选择存在这台设备上，改完立刻生效：聊天页会断开旧连接、用新通道接着收
 * （`features/chat/transport.ts` 与 `use-chat-messages.ts`）。
 */
import { Icon } from '@iconify/react';

import type { ChatTransport } from '@/features/chat/transport';
import { setChatTransport, useChatTransport } from '@/features/chat/transport';

interface TransportOption {
  value: ChatTransport;
  icon: string;
  title: string;
  /** 一句话说清它是什么，别用术语糊过去。 */
  summary: string;
  points: string[];
}

const OPTIONS: TransportOption[] = [
  {
    value: 'sse',
    icon: 'solar:download-minimalistic-linear',
    title: 'SSE（服务端推送）',
    summary:
      '浏览器内建的单向推送：一条普通的 HTTP 长连接，服务端往里写，页面只收不发。',
    points: [
      '断线重连由浏览器管，出问题的面更小',
      '多副本部署时，请求会被转发给正在跑这一轮的那台机器',
      '默认走这条',
    ],
  },
  {
    value: 'ws',
    icon: 'solar:transfer-horizontal-linear',
    title: 'WebSocket',
    summary:
      '一条双向连接：建好之后两头都能随时发消息。这一批只用它收直播流，还没往回发东西。',
    points: [
      '连接建好后开销更小，前后端想加双向交互时不用再换协议',
      '多副本部署时要配 Redis：连接没法转发，内容靠广播到每台机器',
      '实验中——遇到问题可以随时切回 SSE',
    ],
  },
];

export function SettingsPage() {
  const current = useChatTransport();

  return (
    // 与 Notes 页同一套宽度约束（宽度归页面自己管，见 app-layout.tsx）。
    <div className="mx-auto w-full max-w-3xl space-y-10 px-6 py-10 sm:px-8 sm:py-14">
      <header className="space-y-3">
        <p className="text-muted-foreground text-[0.7rem] font-medium tracking-[0.18em] uppercase">
          Preferences
        </p>
        <h1 className="font-display text-5xl leading-[1.02] tracking-tight">
          <span className="italic">Settings</span>
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
          这些选择只存在这台设备上，不跟着账号走。换台机器要重新选。
        </p>
      </header>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-medium">直播流的连接方式</h2>
          <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
            AI 说话时，内容是一小段一小段推过来的。这里选它走哪条路——
            两条推的内容完全一样，改完立刻生效，正在看的会话会自动重连，不会丢内容。
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="直播流的连接方式"
          className="grid gap-3 sm:grid-cols-2"
        >
          {OPTIONS.map((option) => {
            const selected = option.value === current;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                // 名字只取标题：不加的话，读屏软件（和测试）会把整张卡片的说明文字
                // 都念成这个选项的名字——两张卡片的说明里都出现过对方的名字。
                aria-label={option.title}
                onClick={() => {
                  setChatTransport(option.value);
                }}
                className={
                  'flex flex-col gap-3 rounded-2xl border p-5 text-left transition-colors ' +
                  (selected ?
                    'border-foreground/30 bg-card/60'
                  : 'border-foreground/10 hover:border-foreground/20 hover:bg-foreground/[0.02]')
                }
              >
                <div className="flex items-center gap-2">
                  <Icon
                    icon={option.icon}
                    className="text-muted-foreground size-4 shrink-0"
                  />
                  <span className="font-medium">{option.title}</span>
                  {selected && (
                    <span className="border-foreground/20 text-muted-foreground ml-auto rounded-full border px-2 py-0.5 text-[0.65rem] tracking-wide">
                      使用中
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {option.summary}
                </p>
                <ul className="text-muted-foreground space-y-1 text-xs leading-relaxed">
                  {option.points.map((point) => (
                    <li key={point} className="flex gap-2">
                      <span className="text-muted-foreground/50">·</span>
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
