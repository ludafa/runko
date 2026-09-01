-- nimbo 持久化的参考 DDL —— 三张表，三个方言各一份。
--
-- 两条路都留（见 docs/host/contract/tech/persistence.md §7）：
--   ① 直接调包导出的 `migrate(db, { flavor })`，它跑的就是下面这些；
--   ② 想并进自己的迁移体系（drizzle / prisma / flyway / 手写），照抄本文件。
--
-- ⚠️ **`migrate()` 只做首建，不做 schema 演进**：三张表都是 `IF NOT EXISTS`，表已经
-- 存在时它是彻底的 no-op，不会改列、加列或改排序规则。后续版本若动了 schema，老库
-- 必须由宿主自己出一次迁移——本包不带版本表、不记 migration 历史。
--
-- ⚠️ **不能并发调**：Postgres 上多个实例同时跑 `CREATE TABLE IF NOT EXISTS` 会撞
-- `pg_type` 的唯一索引报重复键（Postgres 已知行为）。幂等 ≠ 可并发。

-- ===========================================================================
-- SQLite
-- ===========================================================================
CREATE TABLE IF NOT EXISTS nimbo_ledger (
  conversation_id varchar(255) NOT NULL,
  seq             integer      NOT NULL,
  payload         text         NOT NULL,
  ts              integer      NOT NULL,
  CONSTRAINT nimbo_ledger_pk PRIMARY KEY (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS nimbo_decisions (
  conversation_id varchar(255) NOT NULL,
  tool_call_id    varchar(255) NOT NULL,
  kind            varchar(32)  NOT NULL,
  tool_name       varchar(255),
  payload         text,
  outcome         varchar(32),
  scope           varchar(32),
  decided_by      varchar(255),
  message         text,
  requested_at    integer      NOT NULL,
  decided_at      integer,
  CONSTRAINT nimbo_decisions_pk PRIMARY KEY (conversation_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS nimbo_queue (
  conversation_id varchar(255) NOT NULL,
  id              varchar(255) NOT NULL,
  seq             integer      NOT NULL,
  input           text         NOT NULL,
  created_at      integer      NOT NULL,
  CONSTRAINT nimbo_queue_pk PRIMARY KEY (conversation_id, id),
  -- seq 的唯一性交给数据库：应用层「先查最大值再插」在并发下必然有窗口。
  CONSTRAINT nimbo_queue_seq_uk UNIQUE (conversation_id, seq)
);

-- ===========================================================================
-- PostgreSQL
-- ===========================================================================
CREATE TABLE IF NOT EXISTS nimbo_ledger (
  conversation_id varchar(255) NOT NULL,
  seq             bigint       NOT NULL,
  payload         jsonb        NOT NULL,
  ts              bigint       NOT NULL,
  CONSTRAINT nimbo_ledger_pk PRIMARY KEY (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS nimbo_decisions (
  conversation_id varchar(255) NOT NULL,
  tool_call_id    varchar(255) NOT NULL,
  kind            varchar(32)  NOT NULL,
  tool_name       varchar(255),
  payload         jsonb,
  outcome         varchar(32),
  scope           varchar(32),
  decided_by      varchar(255),
  message         text,
  requested_at    bigint       NOT NULL,
  decided_at      bigint,
  CONSTRAINT nimbo_decisions_pk PRIMARY KEY (conversation_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS nimbo_queue (
  conversation_id varchar(255) NOT NULL,
  id              varchar(255) NOT NULL,
  seq             bigint       NOT NULL,
  input           jsonb        NOT NULL,
  created_at      bigint       NOT NULL,
  CONSTRAINT nimbo_queue_pk PRIMARY KEY (conversation_id, id),
  CONSTRAINT nimbo_queue_seq_uk UNIQUE (conversation_id, seq)
);

-- ===========================================================================
-- MySQL
-- ===========================================================================
-- ⚠️ **主键上的字符串列必须显式 `COLLATE utf8mb4_bin`。** MySQL 8 的默认排序规则
-- `utf8mb4_0900_ai_ci` 大小写与重音都不敏感，而 SQLite 与 Postgres 都区分大小写。
-- 不带它的话 `AbC` 和 `abc` 会被当成同一个 conversationId——跨会话读到别人的账本，
-- 主键上还会撞键；`tool_call_id` 更要紧（各家模型的 call id 本来就是混合大小写）。
CREATE TABLE IF NOT EXISTS nimbo_ledger (
  conversation_id varchar(255) COLLATE utf8mb4_bin NOT NULL,
  seq             bigint       NOT NULL,
  payload         json         NOT NULL,
  ts              bigint       NOT NULL,
  CONSTRAINT nimbo_ledger_pk PRIMARY KEY (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS nimbo_decisions (
  conversation_id varchar(255) COLLATE utf8mb4_bin NOT NULL,
  tool_call_id    varchar(255) COLLATE utf8mb4_bin NOT NULL,
  kind            varchar(32)  NOT NULL,
  tool_name       varchar(255),
  payload         json,
  outcome         varchar(32),
  scope           varchar(32),
  decided_by      varchar(255),
  message         text,
  requested_at    bigint       NOT NULL,
  decided_at      bigint,
  CONSTRAINT nimbo_decisions_pk PRIMARY KEY (conversation_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS nimbo_queue (
  conversation_id varchar(255) COLLATE utf8mb4_bin NOT NULL,
  id              varchar(255) COLLATE utf8mb4_bin NOT NULL,
  seq             bigint       NOT NULL,
  input           json         NOT NULL,
  created_at      bigint       NOT NULL,
  CONSTRAINT nimbo_queue_pk PRIMARY KEY (conversation_id, id),
  CONSTRAINT nimbo_queue_seq_uk UNIQUE (conversation_id, seq)
);
