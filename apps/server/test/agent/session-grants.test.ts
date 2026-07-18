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
});
