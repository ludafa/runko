// 每个测试文件开跑前把 D1 迁移跑一遍（已跑过的会跳过）：与 `wrangler d1 migrations apply` 同一份 SQL。
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
