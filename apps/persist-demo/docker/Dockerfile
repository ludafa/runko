# syntax=docker/dockerfile:1
#
# 多副本验证环境里每个副本用的镜像。构建上下文是**仓库根目录**（compose.yml 里写死了），
# 因为 persist-demo 靠 `workspace:*` 吃 @runko/* 的源码，单拿 apps/persist-demo 构建不出来。
#
# 为什么不是 slim / alpine：better-sqlite3 是原生模块。预编译包下载失败时要现场编译，
# 完整版 bookworm 自带 python3 / make / g++；alpine 用的是 musl，预编译包对不上。
FROM node:24-bookworm

# HUSKY=0：容器里没有 .git，根目录的 `prepare: husky` 不该跑。
ENV HUSKY=0 \
    CI=true \
    PNPM_STORE_DIR=/pnpm/store

RUN npm install -g pnpm@11.11.0

WORKDIR /repo
COPY . .

# 只装 persist-demo 和它依赖链上的包，不装 web / docs / workerd 那一大堆。
# pnpm 的 store 放在构建缓存里：改一行源码重建镜像时不用重新下载几百 MB 依赖。
RUN --mount=type=cache,id=runko-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --filter "@runko-demo/persist-demo..."

# @runko/* 的 package.json `exports` 指向 dist，不先构建就 import 不到。
# `^...` = 只构建它的依赖，不构建 persist-demo 自己（它用 tsx 直接跑源码）。
RUN pnpm --filter "@runko-demo/persist-demo^..." run build

WORKDIR /repo/apps/persist-demo
EXPOSE 3910
# 直接用 node 当主进程，不经 pnpm：pnpm 不一定把 SIGTERM 转给子进程，
# 那样 `docker stop` 就走不到 index.ts 里「先交权再退」的那段。
CMD ["node", "--import", "tsx", "src/index.ts"]
