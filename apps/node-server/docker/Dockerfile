# syntax=docker/dockerfile:1
#
# 多副本验证环境里每个副本用的镜像。构建上下文是**仓库根目录**（compose.yml 里写死了），
# 因为 node-server 靠 `workspace:*` 吃 @runko/* 的源码，单拿 apps/node-server 构建不出来。
#
# 验证环境里跑的是零配置那一档：演示模型 + 本地沙盒，不需要任何云账号。
#
# 两个阶段：`build` 装依赖、编译、挑出运行要的文件；最终镜像只拿这些文件。
# 开发依赖与 TypeScript 源码都不进最终镜像。
#
# 两个阶段都用 alpine，而且必须同一种：原生模块按 C 库分二进制，alpine 是 musl。
# **唯一的原生模块 better-sqlite3 在 arm64 musl 上没有现成二进制**，所以构建阶段装上编译工具
# 让它自己编一份；工具只在构建阶段，最终镜像里没有。
#
# 不能绕过去：遥测那一档用的就是它，而它在模块顶层就被加载——哪怕这个容器跑的是 Postgres。

# ─── 阶段一：装依赖、编译、挑出运行要的文件 ─────────────────────────────────────
FROM node:24-alpine AS build

ENV CI=true

RUN apk add --no-cache python3 make g++ && \
    npm install -g pnpm@11.11.0 && \
    pnpm config set store-dir /pnpm/store

WORKDIR /repo

# 先只拷依赖清单、装依赖，再拷源码：只改源码时，装依赖这层直接命中缓存。
# 全部成员的 package.json 都要拷——pnpm 靠它们核对 lockfile，少一个就对不上。
# 用 `**/package.json` 一把捞，不照抄 pnpm-workspace.yaml 的成员列表：那边加了成员，这里不用跟着改。
COPY --parents package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc **/package.json ./

# 只装 node-server 和它依赖链上的包，不装 web / docs / workerd 那一大堆。
# 两个缓存目录都挂成构建缓存：store 放包本身，/root/.cache/pnpm 放注册表元数据（约 300MB）。
# 后者不挂的话会被原样打进这一层。
#
# **安装脚本要跑**：better-sqlite3 靠它编出本平台的二进制。
# 两个缓存目录都挂成构建缓存：store 放包本身，/root/.cache/pnpm 放注册表元数据（约 300MB）。
RUN --mount=type=cache,id=runko-pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=runko-pnpm-meta,target=/root/.cache/pnpm \
    pnpm install --frozen-lockfile --filter "@runko-chat/node-server..."

# 只拷编译要用的源码，不拷整个仓库：改 docs、apps/web 这些不相干的文件，不会让下面的编译重做。
COPY --parents tsconfig.base.json packages apps/node-server ./

# 编译 node-server 和它依赖的 @runko/*（`...` = 连同依赖，按依赖顺序）。tsc 顺带做类型检查：
# 类型错了，镜像就构建失败。
#
# **分两步，而且应用这一步跑的是 `build:dist` 而不是 `build`**：
# ① `^...` 是「只编依赖、不含自己」——`@runko/*` 只有 `build` 这个脚本，跟着 `build:dist` 一起跑会被跳过，
#    它们的 dist 不在，应用就解析不到 `@runko/core` 的类型。
# ② 应用这一步不生成 `openapi.yml`：那一步要 import 整个 app、把数据库驱动也带进来，
#    构建阶段没必要为了生成一份接口文档去加载驱动。
RUN pnpm --filter "@runko-chat/node-server^..." run build && \
    pnpm --filter @runko-chat/node-server run build:dist

# 把 node-server 连同运行时依赖拷成一个自包含目录 /out：
# 各包只带 `files` 里列的东西（node-server 与 @runko/* 都只有 dist），第三方只带 dependencies。
# 版本照仓库的 lockfile 锁死，/out 里会留一份它专属的 pnpm-lock.yaml。
#
# deploy 要求打开 injectWorkspacePackages。这里只对这一条命令打开，仓库配置不动：
# 那个开关一旦写进 pnpm-workspace.yaml，所有包在本地开发时都会从软链接变成拷贝。
RUN --mount=type=cache,id=runko-pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=runko-pnpm-meta,target=/root/.cache/pnpm \
    pnpm --filter @runko-chat/node-server --config.inject-workspace-packages=true \
         deploy --prod /out

# ─── 阶段二：最终镜像 ─────────────────────────────────────────────────────────
FROM node:24-alpine

ENV NODE_ENV=production

# 用镜像自带的 node 用户跑，不用 root。/app 归它所有：SQLite 那一档要在这里写库文件。
USER node
WORKDIR /app
COPY --from=build --chown=node:node /out .

# 冒烟：整个 app 能不能加载（依赖缺了、原生模块编坏了，在这里就构建失败，不用等副本启动才崩）。
RUN node -e "import('./dist/app.js').then(() => process.exit(0), (error) => { console.error(error); process.exit(1); })"

EXPOSE 3900
# 直接用 node 当主进程，不经 pnpm：pnpm 不一定把 SIGTERM 转给子进程，
# 那样 `docker stop` 就走不到 index.ts 里「先交权再退」的那段。
CMD ["node", "dist/index.js"]
