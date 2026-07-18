// GITHUB_REPO SSH/HTTPS normalization (docs/tech/sandbox.md
// §8.3): re-implemented here (not imported — examples/ isn't a package) with
// the same rules as examples/12-vercel-sandbox-real-project.e2e.test.ts's
// `normalizeGitHubRepo`. Both `sandbox-manager.ts` (clone URL for
// `Sandbox.create`/the `origin` remote rewrite) and `chat-agent.ts`
// (owner/repo baked into instructions) need the parsed form.

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /** Always the HTTPS form, always ending in `.git` — the sandbox has no SSH key. */
  cloneUrl: string;
}

const SSH_REPO_PATTERN = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;
const HTTPS_REPO_PATTERN =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

export class GitHubRepoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubRepoConfigError';
  }
}

/**
 * Accepts both forms `GITHUB_REPO` might hold: SSH
 * (`git@github.com:owner/repo.git`) and HTTPS (`https://github.com/owner/repo`,
 * with or without a trailing `.git`/`/`). Always resolves to the HTTPS form.
 */
export function normalizeGitHubRepo(rawInput: string): GitHubRepoRef {
  const input = rawInput.trim();
  const match =
    input.match(SSH_REPO_PATTERN) ?? input.match(HTTPS_REPO_PATTERN);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) {
    throw new GitHubRepoConfigError(
      `GITHUB_REPO="${rawInput}" isn't a recognizable GitHub repo reference. Expected either the SSH form ` +
        '"git@github.com:owner/repo.git" or the HTTPS form "https://github.com/owner/repo" (see .env.example).',
    );
  }
  return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

/** Reads + normalizes `GITHUB_REPO` lazily (same "no import-time env read" discipline as `model.ts`). */
export function resolveRepo(): GitHubRepoRef {
  const raw = process.env.GITHUB_REPO?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new GitHubRepoConfigError(
      'GITHUB_REPO must be set to use the chat agent (see .env.example).',
    );
  }
  return normalizeGitHubRepo(raw);
}

export function resolveGithubPat(): string {
  const pat = process.env.GITHUB_PAT?.trim();
  if (pat === undefined || pat.length === 0) {
    throw new GitHubRepoConfigError(
      'GITHUB_PAT must be set to use the chat agent (see .env.example).',
    );
  }
  return pat;
}
