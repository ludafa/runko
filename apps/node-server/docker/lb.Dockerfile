# syntax=docker/dockerfile:1
#
# 集群实验环境的统一入口：nginx + 打包好的 chat 前端（docs/host/node/tech/cluster-lab.md §4.1）。
# 构建上下文是**仓库根目录**：前端靠 `workspace:*` 吃 @runko/* 的源码，单拿 apps/web 构建不出来。
#
# 两个阶段：`build` 装依赖、打包前端；最终镜像只有 nginx 和打包产物。

# ─── 阶段一：打包前端 ─────────────────────────────────────────────────────────
FROM node:24-alpine AS build

ENV CI=true

RUN npm install -g pnpm@11.11.0 && \
    pnpm config set store-dir /pnpm/store

WORKDIR /repo

# 先只拷依赖清单、装依赖，再拷源码：只改源码时，装依赖这层直接命中缓存。
# 全部成员的 package.json 都要拷——pnpm 靠它们核对 lockfile，少一个就对不上。
COPY --parents package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc **/package.json ./

# 只装前端和它依赖链上的包。前端没有原生模块，跳过安装脚本。
RUN --mount=type=cache,id=runko-pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=runko-pnpm-meta,target=/root/.cache/pnpm \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@runko-chat/web..."

# 只拷打包要用的源码：改 node-server、docs 这些不相干的文件，不会让下面的打包重做。
COPY --parents tsconfig.base.json packages apps/web ./

# 先编前端依赖的 @runko/*（它们的 `exports` 指向 dist），再打包前端。`tsc -b` 顺带做类型检查：
# 类型错了，镜像就构建失败。
#
# **`SERVER_URL` 置空 = 同源**：正式打包时 `vite.config.ts` 把 `SERVER_URL` 写死成登录客户端的地址，
# 不给就退回 `http://localhost:3000`。置空之后登录客户端与别的接口一样走相对路径 `/api/…`，
# 页面从哪个入口打开，请求就发到哪个入口。
RUN pnpm --filter "@runko-chat/web^..." run build && \
    SERVER_URL= pnpm --filter @runko-chat/web run build

# ─── 阶段二：nginx ───────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

COPY apps/node-server/docker/cluster.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
