/**
 * Cloudflare 沙盒这一档 provider（docs/host/cloudflare/tech/chat-on-cloudflare.md §5.2）。
 *
 * 会话对象和沙盒在同一个 Worker 里，所以走 `@runko/sandbox-cloudflare` 的**进程内网关**：
 * 客户端（`cloudflareWorkspace`）注入的 `fetch` 直接把请求交给同进程的网关，不出网络。
 * 只有克隆仓库这一步绕过网关、直接调沙盒 SDK——网关协议的 `exec` 不带环境变量，而令牌只能放在
 * 那一条命令自己的环境变量里，不能拼进命令字符串。
 */
import type { Sandbox } from '@cloudflare/sandbox';
import { getSandbox } from '@cloudflare/sandbox';
import { cloudflareWorkspace } from '@runko/sandbox-cloudflare';
import type { CfSandboxLike } from '@runko/sandbox-cloudflare/worker';
import { createSandboxGateway } from '@runko/sandbox-cloudflare/worker';
import type {
  CreateSandboxParams,
  ManagedWorkspace,
  ProvisionedSandbox,
  ResumeResult,
  SandboxProvider,
} from '@runko-chat/shared/agent/sandbox-manager';
import {
  forwardKeepAlive,
  withTokenAuth,
} from '@runko-chat/shared/agent/sandbox-manager';

/**
 * 沙盒自己的缺省工作目录。网关把虚拟根 `/` 锚在这里，所以仓库必须克隆到这个目录本身，
 * 共用层那些以 `/` 为 cwd 的初始化命令（装 skill、配 git、切分支）才正好落在仓库里。
 */
const WORKSPACE_ROOT = '/workspace';

/** 克隆先落到这里再拷进工作目录：`git clone` 不肯往非空目录里克隆。 */
const CLONE_STAGING = '/tmp/runko-clone';

const CLONE_TIMEOUT_MS = 2 * 60_000;

/**
 * 进程内网关的握手值，**不是安全边界**：客户端与网关在同一个 isolate 里，这个值不出进程。
 * 网关协议要求带上，照给即可。
 */
const IN_PROCESS_TOKEN = 'in-process-not-a-secret';

export interface CloudflareProviderDeps {
  namespace: DurableObjectNamespace<Sandbox>;
  /** 闲置多久休眠——与共用层的沙盒空闲超时同一个值，DTO 里的 `sleeping` 才推得准。 */
  sleepAfterMs: number;
}

/**
 * 把 `exec` 的 `signal` 剥掉再交给真沙盒：`AbortSignal` 跨不过 Durable Object 的 RPC，
 * 带着它调 `exec` 必报 `AbortSignal serialization is not enabled`（apps/cloudflare-worker-server 实测）。
 * 代价是中途取消不会打断沙盒里正在跑的命令；客户端那边的 `raceAbort` 仍保证及时返回。
 */
function withoutAbortSignal(real: CfSandboxLike): CfSandboxLike {
  return {
    exec: (command, options) =>
      real.exec(command, {
        cwd: options?.cwd,
        timeout: options?.timeout,
        stream: options?.stream,
        onOutput: options?.onOutput,
      }),
    readFile: (path, options) => real.readFile(path, options),
    writeFile: (path, content, options) =>
      real.writeFile(path, content, options),
    mkdir: (path, options) => real.mkdir(path, options),
    deleteFile: (path) => real.deleteFile(path),
    listFiles: (path, options) => real.listFiles(path, options),
  };
}

/** 单引号包起来交给 shell，内容里的单引号转义掉。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createCloudflareProvider(
  deps: CloudflareProviderDeps,
): SandboxProvider {
  const sleepAfter = `${String(Math.max(1, Math.ceil(deps.sleepAfterMs / 1000)))}s`;

  function sandboxFor(name: string) {
    // 名字已经是小写（`runko-chat-<uuid>`），`normalizeId` 只是让 SDK 别再提示。
    return getSandbox(deps.namespace, name, { sleepAfter, normalizeId: true });
  }

  function provisioned(name: string): ProvisionedSandbox {
    const sandbox = sandboxFor(name);
    const gateway = createSandboxGateway({
      token: IN_PROCESS_TOKEN,
      getSandbox: () => withoutAbortSignal(sandbox),
    });
    const base = cloudflareWorkspace({
      url: 'http://sandbox.internal',
      token: IN_PROCESS_TOKEN,
      sandboxId: name,
      fetch: (input, init) => gateway.fetch(new Request(input, init)),
    });
    const workspace: ManagedWorkspace = {
      ...base,
      // 沙盒的休眠计时每收到一次请求就从头算，所以「补足存活时长」就是碰它一下。休眠时长固定
      // 是 `sleepAfter`，比它长的目标补不到——共用层要的审批保活预算没有超过它。
      keepAlive: async () => {
        await sandbox.exec('true', { timeout: 10_000 });
      },
    };
    return {
      workspace,
      resumeToken: name,
      ensureLifetime: forwardKeepAlive(workspace, 'cloudflare'),
    };
  }

  return {
    id: 'cloudflare',
    usesGit: true,
    async create(params: CreateSandboxParams): Promise<ProvisionedSandbox> {
      const sandbox = sandboxFor(params.name);
      const command = [
        `rm -rf ${CLONE_STAGING}`,
        `git clone --depth 1 "${withTokenAuth(params.cloneUrl)}" ${CLONE_STAGING}`,
        `mkdir -p ${WORKSPACE_ROOT}`,
        `cp -a ${CLONE_STAGING}/. ${WORKSPACE_ROOT}/`,
        `rm -rf ${CLONE_STAGING}`,
      ].join(' && ');
      // 令牌只在这一条命令的环境变量里：命令字符串里只有字面量 `$GH_TOKEN`。克隆完 origin 里
      // 带着令牌的地址，由共用层的初始化脚本改回不带令牌的（`resetRemoteUrl`）。
      const clone = await sandbox.exec(command, {
        env: { GH_TOKEN: params.githubToken },
        timeout: CLONE_TIMEOUT_MS,
      });
      if (clone.exitCode !== 0) {
        throw new Error(
          `Cloudflare sandbox: git clone into ${WORKSPACE_ROOT} failed (exit ${String(clone.exitCode)}). ${clone.stderr}`,
        );
      }
      return provisioned(params.name);
    },
    async resume(resumeToken: string): Promise<ResumeResult> {
      // 名字总能拿到一个沙盒，但容器休眠后磁盘是空的：工作目录里没有仓库，就当它没了，
      // 由沙盒管理重新建（重新克隆、装 skill、切回工作分支）。
      const sandbox = sandboxFor(resumeToken);
      const probe = await sandbox.exec(
        `test -d ${shellQuote(`${WORKSPACE_ROOT}/.git`)}`,
        { timeout: 30_000 },
      );
      if (probe.exitCode !== 0) {
        return { kind: 'unavailable' };
      }
      return { kind: 'ok', sandbox: provisioned(resumeToken) };
    },
    // 按名字寻址的沙盒不会「没了」：容器停了下一次请求会把它拉起来，仓库丢了由 `resume` 的探测认出。
    isGone: () => false,
  };
}

/** 用户打开会话页时顺手把沙盒叫醒：容器冷启动要几秒，大多数时候发第一条消息时它已经好了。 */
export async function prewarmCloudflareSandbox(
  deps: CloudflareProviderDeps,
  name: string,
): Promise<void> {
  const sleepAfter = `${String(Math.max(1, Math.ceil(deps.sleepAfterMs / 1000)))}s`;
  await getSandbox(deps.namespace, name, {
    sleepAfter,
    normalizeId: true,
  }).exec('true', { timeout: 60_000 });
}
