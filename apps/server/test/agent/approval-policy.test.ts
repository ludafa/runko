/**
 * Pure-function coverage for `agent/approval-policy.ts` (docs/08-chat-agent-webapp.md
 * §2.2c（审批链）): `resolveApprovalMode` (env parsing), `commandNeedsHumanApproval`
 * (the `'dangerous'` mode's danger checklist), and `shouldAutoAllow` (the
 * mode-dispatch entry point `routes/chat.ts` actually calls). No I/O, no
 * `turn-runner.ts` involved — these are the same pure inputs/outputs the
 * module's own header comment promises.
 */
import { describe, expect, it } from 'vitest';

import {
  commandNeedsHumanApproval,
  resolveApprovalMode,
  shouldAutoAllow,
} from '../../src/agent/approval-policy.js';

describe('agent/approval-policy: resolveApprovalMode', () => {
  it('falls back to "dangerous" when CHAT_APPROVAL_MODE is unset', () => {
    expect(resolveApprovalMode({})).toBe('dangerous');
  });

  it('falls back to "dangerous" when CHAT_APPROVAL_MODE is an empty string', () => {
    expect(resolveApprovalMode({ CHAT_APPROVAL_MODE: '' })).toBe('dangerous');
  });

  it('falls back to "dangerous" for an unrecognized value (typo)', () => {
    expect(resolveApprovalMode({ CHAT_APPROVAL_MODE: 'Dangerous' })).toBe(
      'dangerous',
    );
    expect(resolveApprovalMode({ CHAT_APPROVAL_MODE: 'yolo' })).toBe(
      'dangerous',
    );
  });

  it('passes through each of the three legal values verbatim', () => {
    expect(resolveApprovalMode({ CHAT_APPROVAL_MODE: 'dangerous' })).toBe(
      'dangerous',
    );
    expect(resolveApprovalMode({ CHAT_APPROVAL_MODE: 'all' })).toBe('all');
    expect(resolveApprovalMode({ CHAT_APPROVAL_MODE: 'off' })).toBe('off');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(resolveApprovalMode({ CHAT_APPROVAL_MODE: '  all  ' })).toBe('all');
  });
});

describe('agent/approval-policy: commandNeedsHumanApproval', () => {
  describe('git push', () => {
    it('matches a bare push', () => {
      expect(commandNeedsHumanApproval('git push')).toBe(true);
    });
    it('matches a force push', () => {
      expect(commandNeedsHumanApproval('git push --force origin main')).toBe(
        true,
      );
      expect(commandNeedsHumanApproval('git push -f origin main')).toBe(true);
    });
    it('does not match an unrelated git subcommand', () => {
      expect(commandNeedsHumanApproval('git status')).toBe(false);
    });
  });

  describe('git reset --hard', () => {
    it('matches', () => {
      expect(commandNeedsHumanApproval('git reset --hard HEAD~1')).toBe(true);
    });
    it('does not match a non-hard reset', () => {
      expect(commandNeedsHumanApproval('git reset --soft HEAD~1')).toBe(false);
      expect(commandNeedsHumanApproval('git reset HEAD')).toBe(false);
    });
  });

  describe('git clean -f', () => {
    it('matches -f and combined -fd', () => {
      expect(commandNeedsHumanApproval('git clean -f')).toBe(true);
      expect(commandNeedsHumanApproval('git clean -fd')).toBe(true);
      expect(commandNeedsHumanApproval('git clean --force')).toBe(true);
    });
    it('does not match a dry-run clean', () => {
      expect(commandNeedsHumanApproval('git clean -n')).toBe(false);
      expect(commandNeedsHumanApproval('git clean --dry-run')).toBe(false);
    });
  });

  describe('rm -r/-f', () => {
    it('matches recursive and/or force forms', () => {
      expect(commandNeedsHumanApproval('rm -rf /tmp/build')).toBe(true);
      expect(commandNeedsHumanApproval('rm -f notes.txt')).toBe(true);
      expect(commandNeedsHumanApproval('rm -r some-dir')).toBe(true);
      expect(commandNeedsHumanApproval('rm --recursive some-dir')).toBe(true);
      expect(commandNeedsHumanApproval('rm --force notes.txt')).toBe(true);
    });
    it('does not match a plain rm of a single file', () => {
      expect(commandNeedsHumanApproval('rm somefile.txt')).toBe(false);
    });
  });

  describe('GitHub API curl', () => {
    it('matches a curl referencing api.github.com', () => {
      expect(
        commandNeedsHumanApproval(
          'curl -X POST https://api.github.com/repos/acme/demo/pulls',
        ),
      ).toBe(true);
    });
    it('matches a curl referencing $GH_TOKEN even without api.github.com literally', () => {
      expect(
        commandNeedsHumanApproval(
          'curl -H "Authorization: Bearer $GH_TOKEN" https://example.com/hook',
        ),
      ).toBe(true);
    });
    it('does not match a curl to an unrelated host with no token reference', () => {
      expect(commandNeedsHumanApproval('curl https://example.com')).toBe(false);
    });
  });

  describe('combined commands (&&/;) — a dangerous fragment in non-first position still matches', () => {
    it('matches when the dangerous command follows a safe one via &&', () => {
      expect(
        commandNeedsHumanApproval('cd /repo && git push origin main'),
      ).toBe(true);
    });
    it('matches when the dangerous command follows a safe one via ;', () => {
      expect(commandNeedsHumanApproval('ls -la; git reset --hard HEAD')).toBe(
        true,
      );
    });
  });

  describe('safe commands', () => {
    it('does not flag routine read-only commands', () => {
      expect(commandNeedsHumanApproval('ls')).toBe(false);
      expect(commandNeedsHumanApproval('git status')).toBe(false);
      expect(commandNeedsHumanApproval('cat package.json')).toBe(false);
      expect(commandNeedsHumanApproval('echo hello')).toBe(false);
      expect(commandNeedsHumanApproval('git log --oneline -5')).toBe(false);
    });
  });
});

describe('agent/approval-policy: shouldAutoAllow', () => {
  describe('mode "off"', () => {
    it('is always true, even for a dangerous bash command', () => {
      expect(
        shouldAutoAllow('off', 'bash', { command: 'git push --force' }),
      ).toBe(true);
    });
    it('is always true for a non-bash tool too', () => {
      expect(shouldAutoAllow('off', 'write_file', { path: '/x' })).toBe(true);
    });
  });

  describe('mode "all"', () => {
    it('is always false, even for a safe bash command', () => {
      expect(shouldAutoAllow('all', 'bash', { command: 'ls' })).toBe(false);
    });
    it('is always false for a non-bash tool too', () => {
      expect(shouldAutoAllow('all', 'read_file', { path: '/x' })).toBe(false);
    });
  });

  describe('mode "dangerous"', () => {
    it('is false for any non-bash tool, regardless of input', () => {
      expect(shouldAutoAllow('dangerous', 'write_file', { path: '/x' })).toBe(
        false,
      );
    });

    it('is false when input is not an object (string/number/array/null)', () => {
      expect(shouldAutoAllow('dangerous', 'bash', 'ls')).toBe(false);
      expect(shouldAutoAllow('dangerous', 'bash', 42)).toBe(false);
      expect(shouldAutoAllow('dangerous', 'bash', null)).toBe(false);
    });

    it('is false when input is an array (structurally not the expected shape)', () => {
      expect(shouldAutoAllow('dangerous', 'bash', [])).toBe(false);
      expect(shouldAutoAllow('dangerous', 'bash', ['ls'])).toBe(false);
    });

    it('is false when input has no command field', () => {
      expect(shouldAutoAllow('dangerous', 'bash', { cwd: '/tmp' })).toBe(false);
    });

    it('is false when command is present but not a string', () => {
      expect(shouldAutoAllow('dangerous', 'bash', { command: 123 })).toBe(
        false,
      );
      expect(shouldAutoAllow('dangerous', 'bash', { command: null })).toBe(
        false,
      );
    });

    it('is true for bash with a safe command', () => {
      expect(shouldAutoAllow('dangerous', 'bash', { command: 'ls -la' })).toBe(
        true,
      );
    });

    it('is false for bash with a dangerous command', () => {
      expect(
        shouldAutoAllow('dangerous', 'bash', { command: 'git push' }),
      ).toBe(false);
    });
  });
});
