/**
 * `/design` — 界面语言工作台（dev-only）。
 *
 * 把 chat 页面的每一档状态用固定假数据一次性铺开：不连服务端、不需要登录、
 * 不需要跑一轮真 agent，就能对着看新旧两版的层级、密度、色彩语义。改界面时
 * 对着它迭代，比反复跑真会话快一个量级。
 *
 * 生产构建里这条路由直接 404（`import.meta.env.DEV` 守卫）——它是工具，不是
 * 产品页面。
 */
import { createFileRoute, notFound } from '@tanstack/react-router';

import { DesignPreviewPage } from '@/pages/design-preview';

export const Route = createFileRoute('/design')({
  component: DesignPreviewPage,
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw notFound();
    }
  },
});
