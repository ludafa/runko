/**
 * 会话级授权（session grant，src/agent/session-grants.ts，docs/terms.md §四）：持久化到
 * `conversation_grants`，按 (会话, 用户, tool, 入参指纹) 记账——同用户同调用才命中、
 * 换命令不命中、**按用户隔离**、按会话隔离、键序无关、可清空。每个用例一张全新内存库。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearSessionGrants,
  grantSessionApproval,
  hasSessionGrant,
} from '../../src/agent/session-grants.js';
import type { Db } from '../../src/agent/store.js';
import { createConversation } from '../../src/agent/store.js';
import { conversationGrants } from '../../src/db/schema.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const CONV = 'conv-1';
const USER = 'user-1';
// conversation_grants 的 FK（conversation_id → conversations、user_id → user）在测试库
// 是强制的，故插 grant 前先把这些父行 seed 出来。conversation 的 owner 用谁不影响
// grant 的 user_id FK（后者只指向 user 表，不指向会话归属）。
const USERS = ['user-1', 'user-a', 'user-b', 'user-2'];
const CONVS = ['conv-1', 'conv-a', 'conv-b'];

describe('session-grants', () => {
  let db: Db;
  beforeEach(() => {
    db = createTestDb();
    for (const id of USERS) seedUser(db, id);
    for (const id of CONVS)
      createConversation(db, {
        id,
        userId: USER,
        title: id,
        repo: 'acme/demo',
        branchName: `nimbo/${id}`,
        sandboxName: `sb-${id}`,
      });
  });

  it('grants and matches the exact same call (same conv + user + tool + input)', () => {
    expect(
      hasSessionGrant(db, CONV, USER, 'bash', { command: 'rm -rf build' }),
    ).toBe(false);
    grantSessionApproval(db, CONV, USER, 'bash', { command: 'rm -rf build' });
    expect(
      hasSessionGrant(db, CONV, USER, 'bash', { command: 'rm -rf build' }),
    ).toBe(true);
  });

  it('does NOT match a different command on the same tool (按具体调用，非按工具名)', () => {
    grantSessionApproval(db, CONV, USER, 'bash', { command: 'rm -rf build' });
    // 换命令：指纹不同 → 仍需审批（bash 的安全性正靠这个）。
    expect(
      hasSessionGrant(db, CONV, USER, 'bash', { command: 'git push -f' }),
    ).toBe(false);
    // 同工具名但不同工具也不命中。
    expect(
      hasSessionGrant(db, CONV, USER, 'write-file', {
        command: 'rm -rf build',
      }),
    ).toBe(false);
  });

  it('is isolated per user —— A 的授权不放行 B（多用户前瞻）', () => {
    grantSessionApproval(db, CONV, 'user-a', 'bash', { command: 'ls' });
    expect(hasSessionGrant(db, CONV, 'user-a', 'bash', { command: 'ls' })).toBe(
      true,
    );
    // 同会话、同命令，换个用户 → 不命中：授权只放行授权者本人。
    expect(hasSessionGrant(db, CONV, 'user-b', 'bash', { command: 'ls' })).toBe(
      false,
    );
  });

  it('is isolated per conversation', () => {
    grantSessionApproval(db, 'conv-a', USER, 'bash', { command: 'ls' });
    expect(hasSessionGrant(db, 'conv-a', USER, 'bash', { command: 'ls' })).toBe(
      true,
    );
    expect(hasSessionGrant(db, 'conv-b', USER, 'bash', { command: 'ls' })).toBe(
      false,
    );
  });

  it('input fingerprint is key-order independent (稳定序列化)', () => {
    grantSessionApproval(db, CONV, USER, 'write-file', {
      path: 'a.txt',
      content: 'hi',
    });
    // 同一 JSON 值、键序不同 → 同一指纹 → 命中。
    expect(
      hasSessionGrant(db, CONV, USER, 'write-file', {
        content: 'hi',
        path: 'a.txt',
      }),
    ).toBe(true);
  });

  it('grant is idempotent (重复授权同一条不报错，PK 冲突即忽略)', () => {
    grantSessionApproval(db, CONV, USER, 'bash', { command: 'ls' });
    expect(() =>
      grantSessionApproval(db, CONV, USER, 'bash', { command: 'ls' }),
    ).not.toThrow();
    expect(hasSessionGrant(db, CONV, USER, 'bash', { command: 'ls' })).toBe(
      true,
    );
  });

  it('clearSessionGrants drops all grants for a conversation, all users (会话删除即清)', () => {
    grantSessionApproval(db, CONV, USER, 'bash', { command: 'ls' });
    grantSessionApproval(db, CONV, 'user-2', 'bash', { command: 'pwd' });
    clearSessionGrants(db, CONV);
    expect(hasSessionGrant(db, CONV, USER, 'bash', { command: 'ls' })).toBe(
      false,
    );
    expect(
      hasSessionGrant(db, CONV, 'user-2', 'bash', { command: 'pwd' }),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 分段授权（docs/tech/approval-grant-split.md）：bash 按命令段记账。
  // -------------------------------------------------------------------------

  describe('分段授权（bash 按命令段记）', () => {
    const COMPOUND =
      'cd /home/user/repo && rm -rf node_modules package-lock.json && npm install react react-dom next --no-audit --no-fund 2>&1';

    it('授权一条复合命令后，它的任一子集组合直接命中', () => {
      grantSessionApproval(db, CONV, USER, 'bash', { command: COMPOUND });

      for (const command of [
        COMPOUND,
        'cd /home/user/repo',
        'rm -rf node_modules package-lock.json',
        'npm install react react-dom next --no-audit --no-fund 2>&1',
        // 段重排 / 换连接符 / 丢掉中间一段——段集合是原集合的子集
        'cd /home/user/repo && npm install react react-dom next --no-audit --no-fund 2>&1',
        'npm install react react-dom next --no-audit --no-fund 2>&1 || cd /home/user/repo',
        'rm -rf node_modules package-lock.json ; cd /home/user/repo',
      ]) {
        expect(hasSessionGrant(db, CONV, USER, 'bash', { command })).toBe(true);
      }
    });

    it('含任何一段新命令就不命中（有一段没批过 → 照常弹卡片）', () => {
      grantSessionApproval(db, CONV, USER, 'bash', { command: COMPOUND });

      for (const command of [
        'cd /home/user/repo && npm install zod', // 换了包
        'cd /home/user/repo && rm -rf node_modules package-lock.json && git push', // 多一段危险的
        'npm install react react-dom next --no-audit', // 少一个选项 = 另一条命令
        'cd /home/user/repo2', // 换了目录参数
      ]) {
        expect(hasSessionGrant(db, CONV, USER, 'bash', { command })).toBe(
          false,
        );
      }
    });

    it('授权 rm -rf a 不放行 rm -rf b（不是按命令名记）', () => {
      grantSessionApproval(db, CONV, USER, 'bash', {
        command: 'rm -rf node_modules',
      });
      for (const command of ['rm -rf src', 'rm -rf /', 'rm -rf', 'rm']) {
        expect(hasSessionGrant(db, CONV, USER, 'bash', { command })).toBe(
          false,
        );
      }
    });

    it('授权 npm install 不放行 npm publish（不是按命令名记）', () => {
      grantSessionApproval(db, CONV, USER, 'bash', {
        command: 'npm install react',
      });
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', { command: 'npm publish' }),
      ).toBe(false);
    });

    it('引号造成的词边界差异是两个不同的键（rm -rf "my dir" ≠ rm -rf my dir）', () => {
      grantSessionApproval(db, CONV, USER, 'bash', {
        command: 'rm -rf "my dir"',
      });
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', { command: 'rm -rf my dir' }),
      ).toBe(false);
      // 反过来同样不放行
      grantSessionApproval(db, CONV, USER, 'bash', { command: 'rm -rf a b' });
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', { command: 'rm -rf "a b"' }),
      ).toBe(false);
    });

    it('cwd 进键：换了工作目录不命中', () => {
      grantSessionApproval(db, CONV, USER, 'bash', {
        command: 'rm -rf build',
        cwd: '/repo',
      });
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', {
          command: 'rm -rf build',
          cwd: '/repo',
        }),
      ).toBe(true);
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', {
          command: 'rm -rf build',
          cwd: '/',
        }),
      ).toBe(false);
      // 不带 cwd 与带 cwd 也不是同一条
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', { command: 'rm -rf build' }),
      ).toBe(false);
    });

    it('timeout_ms 不进键：只有它变仍然命中', () => {
      grantSessionApproval(db, CONV, USER, 'bash', {
        command: 'npm run build',
        timeout_ms: 1000,
      });
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', {
          command: 'npm run build',
          timeout_ms: 60000,
        }),
      ).toBe(true);
    });

    it('重定向是命令的一部分：写到别的文件不命中', () => {
      grantSessionApproval(db, CONV, USER, 'bash', {
        command: 'npm run build > ok.log',
      });
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', {
          command: 'npm run build > other.log',
        }),
      ).toBe(false);
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', {
          command: 'npm run build > ok.log',
        }),
      ).toBe(true);
    });

    it('拆不动的命令退回整串匹配（行为与本功能上线前逐字一致）', () => {
      const unsplittable = 'echo $(whoami) && ls';
      grantSessionApproval(db, CONV, USER, 'bash', { command: unsplittable });
      // 整串相同 → 命中
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', { command: unsplittable }),
      ).toBe(true);
      // 整串授权**不**泄漏成分段授权：其中的 `ls` 并没有被单独授权
      expect(hasSessionGrant(db, CONV, USER, 'bash', { command: 'ls' })).toBe(
        false,
      );
      // 反过来，分段授权也不放行拆不动的整串
      grantSessionApproval(db, CONV, USER, 'bash', { command: 'pwd' });
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', { command: 'pwd && $(x)' }),
      ).toBe(false);
    });

    it('非 bash 工具不受影响，仍按整条入参指纹', () => {
      grantSessionApproval(db, CONV, USER, 'write-file', {
        command: 'a && b',
      });
      expect(
        hasSessionGrant(db, CONV, USER, 'write-file', { command: 'a && b' }),
      ).toBe(true);
      expect(
        hasSessionGrant(db, CONV, USER, 'write-file', { command: 'a' }),
      ).toBe(false);
    });

    it('分段授权同样按用户、按会话隔离', () => {
      grantSessionApproval(db, CONV, 'user-a', 'bash', {
        command: 'cd /x && ls',
      });
      expect(
        hasSessionGrant(db, CONV, 'user-a', 'bash', { command: 'ls' }),
      ).toBe(true);
      expect(
        hasSessionGrant(db, CONV, 'user-b', 'bash', { command: 'ls' }),
      ).toBe(false);
      expect(
        hasSessionGrant(db, 'conv-b', 'user-a', 'bash', { command: 'ls' }),
      ).toBe(false);
    });

    it('重复段只记一行，且复合命令的授权是幂等的', () => {
      expect(() => {
        grantSessionApproval(db, CONV, USER, 'bash', { command: 'ls && ls' });
        grantSessionApproval(db, CONV, USER, 'bash', { command: 'ls && ls' });
      }).not.toThrow();
      expect(hasSessionGrant(db, CONV, USER, 'bash', { command: 'ls' })).toBe(
        true,
      );
    });

    it('本功能上线前落下的整串授权行仍然有效（向后兼容，无需迁移回填）', () => {
      // 直接按旧格式插一行——`grantSessionApproval` 如今对可拆的 bash 会走分段，
      // 造不出这种历史行，所以绕过它直插，模拟升级前就存在的数据。
      const legacyInput = { command: 'cd /repo && npm test' };
      db.insert(conversationGrants)
        .values({
          conversationId: CONV,
          userId: USER,
          grantKey: `bash ${JSON.stringify(legacyInput)}`,
          createdAt: new Date(),
        })
        .run();

      expect(hasSessionGrant(db, CONV, USER, 'bash', legacyInput)).toBe(true);
      // 旧行是整串语义，不会被解读成分段授权
      expect(
        hasSessionGrant(db, CONV, USER, 'bash', { command: 'npm test' }),
      ).toBe(false);
    });

    it('clearSessionGrants 同样清掉分段授权', () => {
      grantSessionApproval(db, CONV, USER, 'bash', { command: 'cd /x && ls' });
      clearSessionGrants(db, CONV);
      expect(hasSessionGrant(db, CONV, USER, 'bash', { command: 'ls' })).toBe(
        false,
      );
    });
  });
});
