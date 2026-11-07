-- 由 scripts/generate-d1-migrations.ts 生成，别手改：改表请改共用层的迁移或 better-auth 配置，再重新生成。
-- 已经发出去的迁移文件不能再改（D1 按文件名记哪些跑过），表有变化就生成下一个编号的文件。

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create table if not exists "kysely_migration" ("name" varchar(255) not null primary key, "timestamp" varchar(255) not null);

create table if not exists "kysely_migration_lock" ("id" varchar(255) not null primary key, "is_locked" integer default 0 not null);

insert into "kysely_migration_lock" ("id", "is_locked") values ('migration_lock', 0);

create table "conversations" ("id" varchar(255) primary key, "user_id" varchar(255) not null references "user" ("id"), "title" text not null, "repo" text not null, "branch_name" text not null, "sandbox_name" text not null, "provider" text not null, "sandbox_id" text, "status" text not null, "last_active_at" integer not null, "available_skills_json" text not null, "created_at" integer not null);

create index "conversations_user_id_idx" on "conversations" ("user_id");

create table "push_subscriptions" ("endpoint" varchar(255) primary key, "user_id" varchar(255) not null references "user" ("id") on delete cascade, "p256dh" text not null, "auth" text not null, "user_agent" text, "created_at" integer not null, "last_sent_at" integer, "last_error" text);

create index "push_subscriptions_user_id_idx" on "push_subscriptions" ("user_id");

create table "conversation_grants" ("conversation_id" varchar(255) not null, "user_id" varchar(255) not null, "grant_key" varchar(255) not null, "created_at" integer not null, constraint "conversation_grants_pk" primary key ("conversation_id", "user_id", "grant_key"));

insert into "kysely_migration" ("name", "timestamp") values ('001_initial', '2026-11-07T04:48:41.676Z');

create table "conversations_new" ("id" varchar(255) primary key, "user_id" varchar(255) not null, "title" text not null, "repo" text, "branch_name" text, "sandbox_name" text not null, "provider" text not null, "sandbox_id" text, "status" text not null, "last_active_at" integer not null, "available_skills_json" text not null, "created_at" integer not null);

INSERT INTO conversations_new SELECT id, user_id, title, repo, branch_name, sandbox_name, provider, sandbox_id, status, last_active_at, available_skills_json, created_at FROM conversations;

drop table "conversations";

ALTER TABLE conversations_new RENAME TO conversations;

create index "conversations_user_id_idx" on "conversations" ("user_id");

create table "local_workspaces" ("sandbox_name" varchar(255) primary key, "version" integer not null, "snapshot" text not null, "updated_at" integer not null);

insert into "kysely_migration" ("name", "timestamp") values ('002_local_sandbox', '2026-11-07T04:48:41.677Z');

create table "chat_presence" ("user_id" varchar(255) not null, "conversation_id" varchar(255) not null, "expires_at" integer not null, constraint "chat_presence_pk" primary key ("user_id", "conversation_id"));

insert into "kysely_migration" ("name", "timestamp") values ('003_presence', '2026-11-07T04:48:41.677Z');

alter table "conversations" add column "github_installation_id" integer;

alter table "conversations" add column "github_repo_id" integer;

insert into "kysely_migration" ("name", "timestamp") values ('004_github_repo', '2026-11-07T04:48:41.678Z');

CREATE TABLE "conversation_live" (
  "conversation_id" varchar(255) PRIMARY KEY NOT NULL REFERENCES "conversations" ("id") ON DELETE CASCADE,
  "queued_json" text NOT NULL,
  "turn_in_progress" integer NOT NULL,
  "pending_decisions" integer NOT NULL,
  "updated_at" integer NOT NULL
);

insert into "kysely_migration" ("name", "timestamp") values ('cf_001_conversation_live', '2026-11-07T04:48:41.678Z');
