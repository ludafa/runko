/**
 * 站点结构的单一事实来源。
 *
 * 两级：**导航组**（顶部导航一栏）→ **区段**（一套侧栏）。只有一个区段的组直接
 * 是链接，多个区段的组是下拉菜单。侧栏本身从每份文档的 front matter 现推，所以
 * 新增文档只要放对目录、写好 front matter 就会自己出现。
 *
 * 这张表是配置里唯一手写的部分——它带的是「读的顺序」和「中文名」，推不出来。
 */
export interface Section {
  /** docs/ 下视角目录之前的整段路径，同时也是路由前缀，如 `logic/engine` */
  dir: string;
  /** 导航栏与侧栏标题 */
  text: string;
  /** 侧栏顶部那句话，说清这一段是干什么的 */
  blurb: string;
  /** 导航点进来落在哪份文档（features 下的 slug）——按「该先读哪份」定，不用字母序 */
  landing: string;
}

/** 顶部导航的一栏 */
export interface NavGroup {
  text: string;
  /** 这一栏底下的区段，按阅读顺序 */
  dirs: string[];
}

export const SECTIONS: Section[] = [
  {
    dir: 'architecture',
    landing: 'agent-kernel',
    text: '架构总纲',
    blurb: '两块七个模块、六档部署形态、包怎么拆。先读这份，其余都是它的展开。',
  },

  /* ── agent 逻辑层：框架固定、不可替换的三块，自上而下 ───────────────── */
  {
    dir: 'logic/arbitration',
    landing: 'arbitration-impl',
    text: '归属仲裁',
    blurb:
      '逻辑层最上面那块：保证同一时刻只有一个执行在跑。语义固定，**实现随宿主换**——内存 Map / 租约 / Durable Object 三档都在这里。',
  },
  {
    dir: 'logic/orchestration',
    landing: 'single-ledger',
    text: '轮编排',
    blurb: '逻辑层中间那块（`@runko/agent`）：一轮的一生，外加账本、队列、沙盒生命周期。',
  },
  {
    dir: 'logic/engine',
    landing: 'core-sdk',
    text: '执行引擎',
    blurb: '逻辑层最底下那块（`@runko/core`）：调模型 → 跑工具 → 喂回去。',
  },

  /* ── 宿主层：可替换的那一块。契约只有一份，实现按环境各一份 ─────────── */
  {
    dir: 'host/contract',
    landing: 'sandbox',
    text: '契约（跨环境）',
    blurb:
      '所有宿主环境共同实现的那份接口：沙盒 · 持久化 · 流分发。**这里只写一遍**，各环境怎么落地看下面几段。',
  },
  {
    dir: 'host/node',
    landing: 'deployment',
    text: 'Node 长驻',
    blurb: '单进程 / cluster / Docker / k8s —— 一个不会被平台回收的常驻进程。零配置那一档也在这里。',
  },
  {
    dir: 'host/cloudflare',
    landing: 'deployment',
    text: 'Cloudflare',
    blurb: 'Worker + Durable Object：平台把归属仲裁白送了，代价是沙盒和存储都得走它自己那套。',
  },
  {
    dir: 'host/vercel',
    landing: 'deployment',
    text: 'Vercel',
    blurb: 'Functions（Fluid）+ Sandbox：实例由平台调度、找不到持有者，所以四样能力全要外挂。',
  },
  {
    dir: 'host/e2b',
    landing: 'deployment',
    text: 'E2B',
    blurb: '只提供沙盒这一样能力，可以配在任何一档宿主下面。休眠/唤醒语义最全的一家。',
  },

  {
    dir: 'ingress',
    landing: 'chat-webapp',
    text: '接入层',
    blurb: '构建者写的应用代码——路由、SSE、审批端点、前端。这里的文档是 `apps/` 下那个示例 chat 应用。',
  },
  {
    dir: 'misc',
    landing: 'examples',
    text: '周边',
    blurb: '示例集、验证与验收、文档站本身。',
  },
];

export const NAV: NavGroup[] = [
  { text: '架构', dirs: ['architecture'] },
  { text: 'agent 逻辑层', dirs: ['logic/arbitration', 'logic/orchestration', 'logic/engine'] },
  {
    text: '宿主层',
    dirs: ['host/contract', 'host/node', 'host/cloudflare', 'host/vercel', 'host/e2b'],
  },
  { text: '接入层', dirs: ['ingress'] },
  { text: '周边', dirs: ['misc'] },
];

/**
 * 视角：目录名 · 侧栏分组标题 · front matter 里 `view` 字段的取值。
 * 后两者刻意分开——侧栏标题写全（「技术方案」更清楚），字段值保持 CLAUDE.md
 * 里定的短形式（「技术」），两边不能互相冒充。
 */
export const VIEWS = [
  { dir: 'features', text: '功能', fm: '功能' },
  { dir: 'tech', text: '技术方案', fm: '技术' },
  { dir: 'plans', text: '施工进展', fm: '施工' },
] as const;

/** front matter 里 layer / module 的合法取值（与 docs/terms.md 一致） */
export const LAYERS = ['总纲', '逻辑层', '宿主层', '接入层', '周边'] as const;
/**
 * module 填的是**逻辑模块**，不是宿主环境。宿主环境的落地文档往往横跨好几个
 * 模块（Node 那档就同时讲持久化、仲裁机制、流分发），一律填 `—`，靠 tags 区分。
 *
 * 没有「归属仲裁机制」这个取值——它是归属仲裁模块在宿主层的实现，文档跟语义
 * 并排放在 `logic/arbitration/` 下，统一填「归属仲裁」。
 */
export const MODULES = ['执行引擎', '轮编排', '归属仲裁', '沙盒', '持久化', '流分发', '—'] as const;

export const REPO = 'https://github.com/ludafa/runko';
export const REPO_BLOB = `${REPO}/blob/main`;
