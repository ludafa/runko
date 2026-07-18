/**
 * 12-vercel-sandbox-real-project — a real-project, real-Git-workflow e2e demo
 * (docs/tech/sandbox.md §1/§2, docs/plans/core-sdk.md
 * P11): a nimbo agent, connected to a real Vercel Sandbox, clones the user's
 * own GitHub repo (a plain frontend project), installs the official
 * `anthropics/skills` "frontend-design" skill straight from the sandbox's
 * filesystem (`Skill.fromFS` — nimbo's own, non-standard capability), makes
 * one focused design improvement, then runs the full Git workflow itself:
 * branch, commit, push, open a PR. Vercel's Git integration (assumed already
 * connected for the target project) picks up the push/PR and builds a
 * preview deployment on its own — this script never calls the Vercel deploy
 * API and never promises a deployment URL in its summary, only a PR link
 * (docs/tech/sandbox.md §8.3).
 *
 * ---- File naming / test runner note ----
 *
 * The `.e2e.test.ts` suffix is the user-specified filename (docs/tech/sandbox.md §8.6),
 * NOT a vitest spec — this is still a plain `node`-executed example script
 * like every other file in examples/, run with `node examples/12-....ts`.
 * The root `vitest.config.ts` declares `test.projects: ["packages/*"]`
 * (see that file) and `pnpm-workspace.yaml` only lists `packages/*` as
 * workspace members — examples/ is neither a vitest project root nor a pnpm
 * workspace package, so nothing under examples/ (this file included,
 * regardless of its `.test.ts`-shaped name) is ever discovered by `pnpm -r
 * test` or `pnpm coverage`. Verified empirically while building this example
 * (see the final report): `pnpm -r test` file count is unchanged with this
 * file present.
 *
 * ---- Three sections, not the usual two ----
 *
 * Unlike most other examples/*.ts (deterministic + model-driven), this one's
 * real-project section additionally depends on a real GitHub repo + PAT on
 * top of the model and the Vercel Sandbox credentials — four independent
 * gates, checked in a fixed order, every one of them before any model call
 * or network request (see `realProjectSection()`):
 *
 *   1. a DeepSeek model (this script does NOT use shared/model.ts's
 *      `resolveModel()` — see below)
 *   2. `GITHUB_REPO`
 *   3. `GITHUB_PAT`
 *   4. `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`
 *
 * This repo's checkout has DeepSeek + Vercel Sandbox credentials but no
 * `GITHUB_REPO`/`GITHUB_PAT` (.env.template's newest section) — this
 * section is expected to pass gate 1, stop at gate 2, print guidance, and
 * exit cleanly. The rest of the real-project path (repo cloning, skill
 * install, the git/PR workflow, the agent instructions) compiles and reads
 * correctly but is untested end-to-end in this checkout; results get
 * backfilled into docs/plans/verification.md once a user supplies `GITHUB_REPO`/`GITHUB_PAT`.
 *
 * ---- Why not shared/model.ts's resolveModel() ----
 *
 * Every other model-driven example calls `resolveModel()`, which tries
 * DeepSeek direct-connect first and falls back to an AI SDK Gateway string.
 * This example deliberately does neither of those things as a fallback
 * chain: docs/tech/sandbox.md §8.4 pins DeepSeek specifically (a design-quality task
 * benefits from a stronger tier than the other examples' plain
 * "deepseek-chat" default) and this script constructs `createDeepSeek(...)`
 * itself with a different default model id — see `DEEPSEEK_DESIGN_MODEL_ID`
 * below. `NIMBO_MODEL` still overrides the id (not a gateway string here,
 * same overload note as shared/model.ts's own header comment).
 *
 * The default id, `"deepseek-v4-pro"`, was confirmed the only way this task
 * allowed: `curl -H "Authorization: Bearer $DEEPSEEK_API_TOKEN" \
 * "$DEEPSEEK_API_BASE_URL/models"` (a read-only listing endpoint — the one
 * real network call this construction task was allowed to make, no
 * completion/chat call). The response listed exactly two ids:
 * `deepseek-v4-flash` and `deepseek-v4-pro`; the latter is docs/tech/sandbox.md §8.4's
 * "v4 pro 档". See the final report for the raw response.
 *
 * Root `.env` loading: duplicated from shared/model.ts's private (not
 * exported) `loadRootDotEnv()` rather than importing it, specifically so
 * this file has zero dependency on shared/model.ts's model-resolution
 * behavior — the whole point of the section above is that this script picks
 * its model a different way. The duplicated loader is otherwise byte-for-byte
 * the same technique (Node's built-in `process.loadEnvFile`, already-exported
 * shell vars win over the file). All config lives in the repo-root `.env`
 * now (2026-07-12 consolidation) — see `<repo>/.env.template`.
 *
 * ---- The Git workflow (docs/tech/sandbox.md §1/§2, §8.1/§8.3) ----
 *
 * Host-side (before any model call): `Sandbox.create({ source: { type: "git",
 * url, username: "x-access-token", password: GITHUB_PAT, depth: 1 }, env: {
 * GH_TOKEN: GITHUB_PAT }, runtime: "node24", timeout: 25 * 60_000, persistent:
 * false })` clones the repo; then a handful of `sandbox.runCommand()` calls
 * (never touching the model) install the frontend-design skill (`npx skills`
 * primary path, plain `git clone` fallback), set the commit identity to
 * "nimbo-agent", rewrite `origin`'s URL to embed the PAT for pushing, hide
 * `.agents/`/`.skills/` from `git status` via `.git/info/exclude` (not the
 * repo's own `.gitignore`), and detect the repo's default branch. Only then
 * does the agent get involved: `Skill.fromFS(workspace,
 * "/.agents/skills/frontend-design")`, `defineAgent({ model, skills,
 * instructions })`, `createSession({ workspace })`, `session.stream(...)` — the
 * agent itself runs `git checkout -b <branch>`, edits files, commits, pushes,
 * and opens the PR via a plain `curl` call to the GitHub REST API (no `gh`
 * CLI needed), all through the `bash` tool. `owner`/`repo`/the detected
 * default branch/the branch name are baked into the instructions string by
 * this script — the model is never asked to guess them.
 *
 * GitHub auth is fine-grained-PAT v1 (docs/tech/sandbox.md §8.1): exactly Contents R+W +
 * Pull requests R+W (+ auto Metadata R), scoped to one repo, short expiry,
 * revoke after the run — see .env.template's GITHUB_PAT comment.
 *
 * Run: `node examples/12-vercel-sandbox-real-project.e2e.test.ts` (see
 * examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars, no network): prints
 *      two `normalizeGitHubRepo()` self-checks (SSH form and HTTPS form
 *      resolving to the same owner/repo/HTTPS clone URL, asserted inline),
 *      the full host-side init command plan (unexecuted, just printed for
 *      the reader), and one `Skill.fromFS()` load against an in-process fake
 *      `VercelSandboxLike` pre-seeded with a representative frontend-design
 *      `SKILL.md` (name + description printed) — proving the loading
 *      mechanics work with zero credentials, zero network, and no real
 *      `@vercel/sandbox` import.
 *   2. A real-project section, gated on the four things listed above, in
 *      order — this checkout stops at gate 2 (`GITHUB_REPO` unset), printing
 *      guidance and exiting cleanly (code 0) before any sandbox or model
 *      call. With all four configured: a real Vercel Sandbox is created from
 *      the target repo, initialized, handed to a session with the
 *      frontend-design skill loaded, and asked to make one focused design
 *      improvement and open a PR — printing the loop's execution **live** as
 *      a typed event timeline (`session.stream()` consumed with the manual
 *      `.next()` idiom from 07-streaming: tool calls walking in_progress →
 *      completed, file_change items, agent text as a typewriter), followed by
 *      the session's `finalResponse` (which must include the changed files +
 *      design rationale, the branch name, and the PR's `html_url`), then
 *      `sandbox.stop()`s in a `finally` block.
 */
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { Sandbox } from "@vercel/sandbox";
import { createSession, defineAgent, Skill } from "@nimbo/sdk";
import type { NimboChunk, TurnResult } from "@nimbo/sdk";
import { vercelWorkspace } from "@nimbo/sandbox-vercel";
import { TranscriptStore } from "./shared/transcript-store.ts";
import type {
  VercelCommandResultLike,
  VercelDirentLike,
  VercelFileSystemLike,
  VercelRunCommandParams,
  VercelSandboxLike,
  VercelStatsLike,
} from "@nimbo/sandbox-vercel";

const ROOT = "/vercel/sandbox";

// ---- 1. GITHUB_REPO SSH/HTTPS normalization (exported, self-tested below) ----

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /** Always the HTTPS form, always ending in `.git` — the sandbox has no SSH key. */
  cloneUrl: string;
}

const SSH_REPO_PATTERN = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;
const HTTPS_REPO_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/**
 * Accepts both forms `GITHUB_REPO` might hold (docs/tech/sandbox.md §8.3): SSH
 * (`git@github.com:owner/repo.git`) and HTTPS (`https://github.com/owner/repo`,
 * with or without a trailing `.git`/`/`). Always resolves to the HTTPS form —
 * `Sandbox.create`'s git source and the `git remote set-url` the sandbox init
 * step runs both need HTTPS + PAT, never SSH (no SSH key ever enters the
 * sandbox). Throws a guidance-shaped error (not a bare parse failure) when
 * neither pattern matches, pointing at .env.template.
 */
export function normalizeGitHubRepo(rawInput: string): GitHubRepoRef {
  const input = rawInput.trim();
  const match = input.match(SSH_REPO_PATTERN) ?? input.match(HTTPS_REPO_PATTERN);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) {
    throw new Error(
      `GITHUB_REPO="${rawInput}" isn't a recognizable GitHub repo reference. Expected either the SSH form ` +
        '"git@github.com:owner/repo.git" or the HTTPS form "https://github.com/owner/repo" ' +
        '(see .env.template\'s "Real-project design-optimize e2e" section).',
    );
  }
  return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

// ---- 2. host-side sandbox init plan (printed unexecuted in the deterministic ----
// ----    section, actually run against a real sandbox in the real section) ----

interface InitStep {
  label: string;
  script: string;
}

interface InitPlan {
  installSkill: InitStep;
  cloneFallback: InitStep;
  gitIdentity: InitStep;
  remoteAuth: InitStep;
  gitExclude: InitStep;
  detectDefaultBranch: InitStep;
}

/** Fixed fetch order used both to print the plan and to actually run it — see `initPlanSteps()`. */
function initPlanSteps(plan: InitPlan): InitStep[] {
  return [plan.installSkill, plan.cloneFallback, plan.gitIdentity, plan.remoteAuth, plan.gitExclude, plan.detectDefaultBranch];
}

/**
 * Six host-side `runCommand` calls (docs/tech/sandbox.md §2.3/§2.4), none of them routed
 * through the model. `remoteAuth` reads the PAT from the sandbox's own
 * `$GH_TOKEN` environment variable (set via `Sandbox.create`'s `env` option)
 * rather than interpolating the PAT into this script's command string — the
 * token never appears as a literal in code the host builds, only as a shell
 * env var the sandbox already has.
 */
function buildInitPlan(owner: string, repo: string): InitPlan {
  return {
    installSkill: {
      label: "install the frontend-design skill (primary path: npx skills CLI, unattended)",
      script: "npx -y skills add anthropics/skills --skill frontend-design -a cursor -y",
    },
    cloneFallback: {
      label: "fallback if npx skills didn't produce the skill file: a plain git clone (always available)",
      script:
        "test -f .agents/skills/frontend-design/SKILL.md || " +
        "(git clone --depth 1 https://github.com/anthropics/skills /tmp/nimbo-skills-src && " +
        "mkdir -p .agents/skills && cp -r /tmp/nimbo-skills-src/skills/frontend-design .agents/skills/)",
    },
    gitIdentity: {
      label: "set the commit identity the agent's commits will carry",
      script: 'git config user.name "nimbo-agent" && git config user.email "nimbo-agent@users.noreply.github.com"',
    },
    remoteAuth: {
      label: "rewrite origin's URL to embed the PAT for pushing (PAT read from the sandbox's own $GH_TOKEN, never interpolated here)",
      script: `git remote set-url origin "https://x-access-token:$GH_TOKEN@github.com/${owner}/${repo}.git"`,
    },
    gitExclude: {
      label: "hide .agents/ and .skills/ from `git status` via .git/info/exclude (never touches the repo's own .gitignore)",
      script: "printf '%s\\n' '.agents/' '.skills/' >> .git/info/exclude",
    },
    detectDefaultBranch: {
      label: "detect the repo's default branch (used as the PR base and the agent's checkout starting point)",
      script: "git symbolic-ref refs/remotes/origin/HEAD",
    },
  };
}

// ---- 3. deterministic section ----

/**
 * A short, representative frontend-design SKILL.md — NOT a copy of the real
 * ~8.3KB anthropics/skills file (this script never fetches the network in
 * its deterministic section), just enough frontmatter + body for
 * `Skill.fromFS()` to prove the packaged-skill loading mechanics work. The
 * real-project section installs and loads the actual official skill.
 */
const FRONTEND_DESIGN_SKILL_STUB = `---
description: Make one focused, non-generic visual/interaction improvement to an existing web UI without rewriting it or changing its framework.
---
# frontend-design (representative stub for the deterministic demo)

Pick a single meaningful improvement (spacing, hierarchy, motion, feedback on
interaction) and execute it well, rather than a broad shallow pass over
everything. Prefer the project's existing tokens/conventions over introducing
new ones.
`;

/** A `VercelSandboxLike` fake pre-seeded with `.agents/skills/frontend-design/SKILL.md` (same shape as examples/10's fake). */
function createFakeSandboxWithSkill(): VercelSandboxLike {
  const skillPath = `${ROOT}/.agents/skills/frontend-design/SKILL.md`;
  const files = new Map<string, Uint8Array>([[skillPath, new TextEncoder().encode(FRONTEND_DESIGN_SKILL_STUB)]]);
  const dirs = new Set<string>([ROOT, `${ROOT}/.agents`, `${ROOT}/.agents/skills`, `${ROOT}/.agents/skills/frontend-design`]);

  function notFound(path: string): Error {
    return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
  }

  const fs: VercelFileSystemLike = {
    async readFile(path) {
      const data = files.get(path);
      if (data === undefined) throw notFound(path);
      return data;
    },
    async writeFile(path, data) {
      files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    },
    async mkdir(path) {
      dirs.add(path);
      return path;
    },
    async readdir(path) {
      const prefix = `${path}/`;
      const entries: VercelDirentLike[] = [];
      for (const p of files.keys()) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) {
          entries.push({ name: p.slice(prefix.length), isDirectory: () => false, isFile: () => true });
        }
      }
      return entries;
    },
    async stat(path) {
      const data = files.get(path);
      if (data === undefined && !dirs.has(path)) throw notFound(path);
      const isDir = data === undefined;
      const result: VercelStatsLike = { isDirectory: () => isDir, isFile: () => !isDir, size: data?.byteLength ?? 0, mtimeMs: Date.now() };
      return result;
    },
    async rm(path) {
      files.delete(path);
    },
    async rmdir(path) {
      dirs.delete(path);
    },
  };

  return {
    fs,
    async runCommand(params: VercelRunCommandParams): Promise<VercelCommandResultLike> {
      const text = `ran: ${params.cmd} ${(params.args ?? []).join(" ")}\n`;
      params.stdout?.write(text);
      return { exitCode: 0 };
    },
  };
}

function selfTestNormalizeGitHubRepo(): void {
  const fromSsh = normalizeGitHubRepo("git@github.com:octocat/schulte-grid.git");
  const fromHttps = normalizeGitHubRepo("https://github.com/octocat/schulte-grid");

  assert.deepEqual(fromSsh, { owner: "octocat", repo: "schulte-grid", cloneUrl: "https://github.com/octocat/schulte-grid.git" });
  assert.deepEqual(fromHttps, fromSsh);
  console.log("normalizeGitHubRepo(SSH) ->", fromSsh);
  console.log("normalizeGitHubRepo(HTTPS) ->", fromHttps);

  try {
    normalizeGitHubRepo("not-a-github-repo");
    assert.fail("expected normalizeGitHubRepo to throw on an unrecognizable input");
  } catch (error) {
    console.log("normalizeGitHubRepo(<garbage>) throws:", error instanceof Error ? error.message : String(error));
  }
}

async function deterministicSection(): Promise<void> {
  console.log("--- 1. GITHUB_REPO SSH<->HTTPS normalization (asserted) ---");
  selfTestNormalizeGitHubRepo();

  console.log("\n--- 2. host-side sandbox init plan (printed here, unexecuted; run for real in the real-project section) ---");
  for (const step of initPlanSteps(buildInitPlan("octocat", "schulte-grid"))) {
    console.log(`\n# ${step.label}\n$ ${step.script}`);
  }

  console.log("\n--- 3. Skill.fromFS() against a fake VercelSandboxLike pre-seeded with a SKILL.md ---");
  const workspace = vercelWorkspace(createFakeSandboxWithSkill());
  const skill = await Skill.fromFS(workspace, "/.agents/skills/frontend-design");
  console.log(`loaded skill "${skill.name}": ${skill.description}`);
}

// ---- 4. real-project section (gated) ----

const DEEPSEEK_DESIGN_MODEL_ID = "deepseek-v4-pro"; // confirmed via GET {DEEPSEEK_API_BASE_URL}/models — see file header

/**
 * `process.loadEnvFile`'s thrown value is `unknown` at the catch boundary —
 * same controlled narrowing pattern as shared/model.ts's own `isEnoentError`
 * (duplicated rather than imported, see file header "Why not shared/model.ts's
 * resolveModel()").
 */
function isEnoentError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function loadRootDotEnv(): void {
  // this file is in examples/, so "../.env" is the repo-root .env
  const dotEnvPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  try {
    process.loadEnvFile(dotEnvPath);
  } catch (error) {
    if (!isEnoentError(error)) throw error;
  }
}

/** DeepSeek-only, with a different default model id than shared/model.ts's `resolveModel()` — see file header. */
function resolveDesignModel(): LanguageModel | undefined {
  const baseURL = process.env.DEEPSEEK_API_BASE_URL?.trim();
  const apiKey = process.env.DEEPSEEK_API_TOKEN?.trim();
  if (baseURL === undefined || baseURL.length === 0 || apiKey === undefined || apiKey.length === 0) return undefined;

  const deepseek = createDeepSeek({ baseURL, apiKey });
  const modelId = process.env.NIMBO_MODEL?.trim();
  return deepseek(modelId === undefined || modelId.length === 0 ? DEEPSEEK_DESIGN_MODEL_ID : modelId);
}

function generateBranchName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `nimbo/design-${stamp}`;
}

/** Parses `git symbolic-ref refs/remotes/origin/HEAD`'s stdout (e.g. "refs/remotes/origin/main\n") down to "main". */
function parseDefaultBranch(symbolicRefStdout: string): string | undefined {
  const trimmed = symbolicRefStdout.trim();
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1 || idx === trimmed.length - 1) return undefined;
  return trimmed.slice(idx + 1);
}

/** Runs one host-side init command, printing it (label + script + output + exit code) as it goes. */
async function runHostCommand(sandbox: Sandbox, step: InitStep, opts?: { timeoutMs?: number }): Promise<{ exitCode: number; output: string }> {
  console.log(`\n[init] ${step.label}\n$ ${step.script}`);
  const finished = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", step.script],
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const output = await finished.output("both");
  if (output.length > 0) console.log(output);
  console.log(`exit ${String(finished.exitCode)}`);
  return { exitCode: finished.exitCode, output };
}

const DEFAULT_BRANCH_FALLBACK = "main";

/** Runs the six-step init plan against a real sandbox; returns the detected default branch (or the fallback). */
async function initializeSandbox(sandbox: Sandbox, owner: string, repo: string): Promise<string> {
  const plan = buildInitPlan(owner, repo);

  const installResult = await runHostCommand(sandbox, plan.installSkill, { timeoutMs: 5 * 60_000 });
  if (installResult.exitCode !== 0) console.log("(npx skills didn't succeed — trying the git-clone fallback next)");

  const fallbackResult = await runHostCommand(sandbox, plan.cloneFallback, { timeoutMs: 2 * 60_000 });
  if (fallbackResult.exitCode !== 0) {
    throw new Error("Both the npx skills install and the git-clone fallback failed to produce .agents/skills/frontend-design/SKILL.md.");
  }

  const identityResult = await runHostCommand(sandbox, plan.gitIdentity);
  if (identityResult.exitCode !== 0) throw new Error(`git identity setup failed (exit ${String(identityResult.exitCode)}).`);

  const remoteResult = await runHostCommand(sandbox, plan.remoteAuth);
  if (remoteResult.exitCode !== 0) throw new Error(`git remote set-url failed (exit ${String(remoteResult.exitCode)}).`);

  // Best-effort, not fatal: worst case the install artifacts show up in `git status` and the agent has to work around it.
  await runHostCommand(sandbox, plan.gitExclude);

  const branchResult = await runHostCommand(sandbox, plan.detectDefaultBranch);
  const defaultBranch = branchResult.exitCode === 0 ? parseDefaultBranch(branchResult.output) : undefined;
  if (defaultBranch === undefined) {
    console.log(`could not detect the default branch — falling back to "${DEFAULT_BRANCH_FALLBACK}"`);
    return DEFAULT_BRANCH_FALLBACK;
  }
  return defaultBranch;
}

/** Chinese instructions (this repo's convention for task-facing prose) with owner/repo/branch/base baked in — the model is never asked to guess them. */
function buildInstructions(opts: { owner: string; repo: string; defaultBranch: string; branchName: string }): string {
  const { owner, repo, defaultBranch, branchName } = opts;
  return `你在一个已经 clone 好用户仓库 ${owner}/${repo}（默认分支 ${defaultBranch}）的 Vercel Sandbox 里工作，仓库根目录就是你的工作区根目录 "/"。请按以下顺序完成一次「frontend-design skill 驱动的设计优化」，并走完整的 Git 工作流：

1. 先调用 load-skill 加载 "frontend-design"，理解它的设计哲学与检查清单。
2. 用 read-file/list-dir/grep 等工具通读现有代码，理解这是一个什么项目（这是一个纯前端的舒尔特方格训练小游戏）。
3. 按 skill 的设计哲学，做「一次聚焦的」视觉或交互优化——挑一个有意义的改进点做深做透即可，不要大面积重写、不要更换技术栈或框架。
4. 如果仓库根目录有 package.json，用 bash 跑一次构建命令（例如 npm run build；如果没有对应脚本就跳过，并在最终回复里如实说明）验证改动没有破坏构建。
5. 用 bash 依次执行下面的 Git 流程：
   git checkout -b ${branchName}
   git add -A
   git commit -m "<一条清楚说明设计意图的 commit message>"
   git push -u origin ${branchName}
6. 用 bash 执行下面的命令创建 Pull Request（$GH_TOKEN 已经是沙盒里的环境变量，直接引用它，不要自己猜测、复述或打印它的值）：
   curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" https://api.github.com/repos/${owner}/${repo}/pulls -d '{"title": "<PR 标题>", "head": "${branchName}", "base": "${defaultBranch}", "body": "<说明本次改了什么、为什么这么改>"}'
   从返回的 JSON 里取出 html_url 字段，这就是本次 PR 的链接。
7. 最终回复必须包含以下三项，缺一不可：
   - 具体改了哪些文件、每处改动背后的设计意图（为什么这么改，不只是改了什么）
   - 本次使用的分支名：${branchName}
   - 创建的 PR 链接（上一步返回的 html_url）
8. 任何一步失败（例如构建失败、push 被拒绝、创建 PR 失败）都必须在最终回复里如实说明具体失败原因，不要反复重试硬撑，也不要编造一个并未真正发生的成功结果。`;
}

function formatChunk(chunk: NimboChunk): string {
  switch (chunk.type) {
    case "tool-input-available":
      return `[tool-input-available] ${chunk.toolName}  input=${JSON.stringify(chunk.input).slice(0, 160)}`;
    case "tool-output-available":
      return `[tool-output-available] callId=${chunk.toolCallId}`;
    default:
      return `[${chunk.type}]`;
  }
}

/**
 * Live timeline printer for the agent's execution — the manual `.next()`
 * driving idiom from 07-streaming (a `for-await` would discard the
 * generator's `return` value, i.e. the TurnResult). Two rendering rules,
 * both borrowed from 07:
 *   - `text-delta` / `reasoning-delta` are typewritten with
 *     `process.stdout.write` (only the new slice per chunk, never a reprint);
 *   - every other `NimboChunk` gets one `formatChunk` timeline line — for a
 *     long design session that's the `tool-input-available` /
 *     `tool-output-available` walk (`git push`/`curl` style bash calls) you
 *     actually want to watch scroll by here.
 */
async function streamLive(
  stream: AsyncGenerator<NimboChunk, TurnResult>,
  onChunk?: (chunk: NimboChunk) => void,
): Promise<TurnResult> {
  let midLine = false;

  function logLine(text: string): void {
    if (midLine) {
      process.stdout.write("\n");
      midLine = false;
    }
    console.log(text);
  }

  let step = await stream.next();
  while (!step.done) {
    const chunk = step.value;
    onChunk?.(chunk);
    if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
      if (chunk.delta.length > 0) {
        process.stdout.write(chunk.delta);
        midLine = true;
      }
    } else {
      logLine(formatChunk(chunk));
    }
    step = await stream.next();
  }
  return step.value;
}

async function realProjectSection(): Promise<void> {
  loadRootDotEnv();

  console.log("\n--- 4. real Vercel Sandbox + real GitHub repo: a frontend-design optimization PR ---");

  // Gate 1: model (DeepSeek-only for this example, see file header — no AI SDK Gateway fallback here).
  const model = resolveDesignModel();
  if (model === undefined) {
    console.log(
      "[nimbo example] DeepSeek is not configured — skipping the real-project section.\n" +
        "This example is DeepSeek-only (docs/tech/sandbox.md §8.4 pins a stronger tier for the design task), unlike other\n" +
        "examples' resolveModel() dual path. Set in the repo-root .env:\n" +
        "  DEEPSEEK_API_BASE_URL=...\n" +
        "  DEEPSEEK_API_TOKEN=...\n" +
        `Optionally: NIMBO_MODEL=... to override the default "${DEEPSEEK_DESIGN_MODEL_ID}".`,
    );
    return;
  }

  // Gate 2: GITHUB_REPO.
  const rawRepo = process.env.GITHUB_REPO?.trim();
  if (rawRepo === undefined || rawRepo.length === 0) {
    console.log(
      "[nimbo example] GITHUB_REPO is not set — skipping the real-project section.\n" +
        'See .env.template\'s "Real-project design-optimize e2e" section: either the SSH form\n' +
        '("git@github.com:owner/repo.git") or the HTTPS form ("https://github.com/owner/repo") is accepted.\n' +
        "No sandbox is created and no model call is made while this is missing.",
    );
    return;
  }

  // Gate 3: GITHUB_PAT.
  const ghToken = process.env.GITHUB_PAT?.trim();
  if (ghToken === undefined || ghToken.length === 0) {
    console.log(
      "[nimbo example] GITHUB_PAT is not set — skipping the real-project section.\n" +
        "A fine-grained PAT scoped to ONLY the target repo, with exactly Contents: Read and write +\n" +
        'Pull requests: Read and write (see .env.template). No sandbox is created and no model\n' +
        "call is made while this is missing.",
    );
    return;
  }

  // Gate 4: Vercel Sandbox credentials (same three variables as examples/10-sandbox-vercel.ts).
  const vercelToken = process.env.VERCEL_TOKEN?.trim();
  const vercelTeamId = process.env.VERCEL_TEAM_ID?.trim();
  const vercelProjectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (
    vercelToken === undefined ||
    vercelToken.length === 0 ||
    vercelTeamId === undefined ||
    vercelTeamId.length === 0 ||
    vercelProjectId === undefined ||
    vercelProjectId.length === 0
  ) {
    console.log(
      "[nimbo example] VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID are not fully set — skipping the real-project section.\n" +
        'See the "Vercel Sandbox" section of .env.template for where to get each value. No sandbox is ' +
        "created and no model call is made while any of the three is missing.",
    );
    return;
  }

  let repoRef: GitHubRepoRef;
  try {
    repoRef = normalizeGitHubRepo(rawRepo);
  } catch (error) {
    console.log(`[nimbo example] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const branchName = generateBranchName();
  console.log(`target repo: ${repoRef.owner}/${repoRef.repo} (${repoRef.cloneUrl})`);
  console.log(`branch to be created: ${branchName}`);

  const sandbox = await Sandbox.create({
    token: vercelToken,
    teamId: vercelTeamId,
    projectId: vercelProjectId,
    runtime: "node24",
    timeout: 25 * 60_000,
    persistent: false, // demo run, nothing worth resuming — see examples/10's header comment for the same reasoning
    source: { type: "git", url: repoRef.cloneUrl, username: "x-access-token", password: ghToken, depth: 1 },
    env: { GH_TOKEN: ghToken },
  });

  try {
    const defaultBranch = await initializeSandbox(sandbox, repoRef.owner, repoRef.repo);

    const workspace = vercelWorkspace(sandbox);
    const skill = await Skill.fromFS(workspace, "/.agents/skills/frontend-design");
    console.log(`\nloaded skill "${skill.name}": ${skill.description}`);

    const agent = defineAgent({
      model,
      skills: [skill],
      instructions: buildInstructions({ owner: repoRef.owner, repo: repoRef.repo, defaultBranch, branchName }),
    });
    const session = createSession(agent, { workspace });

    // Every run's full transcript (all NimboChunks + finalResponse + the
    // serialized SessionState) is persisted to a local SQLite DB — default
    // `<repo>/.transcripts/examples-transcript.sqlite`, override with
    // NIMBO_TRANSCRIPT_DB. Query it later with e.g.
    //   sqlite3 .transcripts/examples-transcript.sqlite "SELECT id, status, started_at FROM runs"
    const store = new TranscriptStore();
    const runId = store.startRun({
      example: "12-vercel-sandbox-real-project",
      sessionId: session.id,
      meta: { repo: `${repoRef.owner}/${repoRef.repo}`, branch: branchName, defaultBranch },
    });
    console.log(`\ntranscript -> ${store.dbPath} (run ${runId})`);

    try {
      console.log("\n--- live agent execution (event timeline) ---");
      const result = await streamLive(
        session.stream(
          "对这个仓库执行一次 frontend-design skill 驱动的设计优化，并完整走一遍 Git 工作流（建分支、改代码、commit、push、开 PR）。请严格按照 system instructions 里列出的步骤执行到底。",
        ),
        (event) => store.recordEvent(runId, event),
      );

      store.finishRun(runId, { status: "completed", result, sessionState: session.toJSON() });
      console.log("\n--- finalResponse ---");
      console.log(result.finalResponse);
    } catch (error) {
      store.finishRun(runId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      store.close();
    }
  } finally {
    await sandbox.stop();
  }
}

await deterministicSection();
await realProjectSection();
