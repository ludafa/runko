# syntax=docker/dockerfile:1
#
# 多副本验证环境里每个副本用的镜像。构建上下文是**仓库根目录**（compose.yml 里写死了），
# 因为 persist-demo 靠 `workspace:*` 吃 @runko/* 的源码，单拿 apps/persist-demo 构建不出来。
#
# 两个阶段：`build` 装依赖、编译、挑出运行要的文件；最终镜像只拿这些文件。
# 开发依赖与 TypeScript 源码都不进最终镜像。
#
# 两个阶段都用 alpine，而且必须同一种：原生模块按 C 库分二进制，alpine 是 musl。
# 唯一的原生模块 better-sqlite3 包里自带各平台二进制（含 linuxmusl），
# 所以不装 python3 / make / g++，也不让它跑编译（见下面的 --ignore-scripts）。

# ─── 阶段一：装依赖、编译、挑出运行要的文件 ─────────────────────────────────────
FROM node:24-alpine AS build

ENV CI=true

RUN npm install -g pnpm@11.11.0 && \
    pnpm config set store-dir /pnpm/store

WORKDIR /repo

# 先只拷依赖清单、装依赖，再拷源码：只改源码时，装依赖这层直接命中缓存。
# 全部成员的 package.json 都要拷——pnpm 靠它们核对 lockfile，少一个就对不上。
# 用 `**/package.json` 一把捞，不照抄 pnpm-workspace.yaml 的成员列表：那边加了成员，这里不用跟着改。
COPY --parents package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc **/package.json ./

# 只装 persist-demo 和它依赖链上的包，不装 web / docs / workerd 那一大堆。
# 两个缓存目录都挂成构建缓存：store 放包本身，/root/.cache/pnpm 放注册表元数据（约 300MB）。
# 后者不挂的话会被原样打进这一层。
#
# --ignore-scripts：运行时依赖里只有 better-sqlite3 带安装脚本。它包里有 binding.gyp，
# pnpm 就会替它跑 `node-gyp rebuild`，没有编译工具就失败；可它加载时先找包里自带的二进制，
# 编出来的那份根本用不上。开发依赖里的 esbuild（tsx、vitest 用）也有安装脚本，编译用不到它。
# 代价是依赖链上的安装脚本一律不跑，所以最终阶段有一步冒烟，把「原生模块加载不了」提前到构建期。
RUN --mount=type=cache,id=runko-pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=runko-pnpm-meta,target=/root/.cache/pnpm \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@runko-demo/persist-demo..."

# 只拷编译要用的源码，不拷整个仓库：改 docs、apps/web 这些不相干的文件，不会让下面的编译重做。
COPY --parents tsconfig.base.json packages apps/persist-demo ./

# 编译 persist-demo 和它依赖的 @runko/*（`...` = 连同依赖，按依赖顺序）。
# persist-demo 的 build 是 tsc，顺带做类型检查：类型错了，镜像就构建失败。
RUN pnpm --filter "@runko-demo/persist-demo..." run build

# 把 persist-demo 连同运行时依赖拷成一个自包含目录 /out：
# 各包只带 `files` 里列的东西（persist-demo 与 @runko/* 都只有 dist），第三方只带 dependencies。
# 版本照仓库的 lockfile 锁死，/out 里会留一份它专属的 pnpm-lock.yaml。
#
# deploy 要求打开 injectWorkspacePackages。这里只对这一条命令打开，仓库配置不动：
# 那个开关一旦写进 pnpm-workspace.yaml，所有包在本地开发时都会从软链接变成拷贝。
RUN --mount=type=cache,id=runko-pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=runko-pnpm-meta,target=/root/.cache/pnpm \
    pnpm --filter @runko-demo/persist-demo --config.inject-workspace-packages=true \
         deploy --prod --ignore-scripts /out

# ─── 阶段二：最终镜像 ─────────────────────────────────────────────────────────
FROM node:24-alpine

ENV NODE_ENV=production

# 用镜像自带的 node 用户跑，不用 root。/app 归它所有：SQLite 那一档要在这里写库文件。
USER node
WORKDIR /app
COPY --from=build --chown=node:node /out .

# 冒烟：上面跳过了安装脚本，原生模块若加载不了，在这里就构建失败，不用等副本启动才崩。
RUN node -e "new (require('better-sqlite3'))(':memory:').close()"

EXPOSE 3910
# 直接用 node 当主进程，不经 pnpm：pnpm 不一定把 SIGTERM 转给子进程，
# 那样 `docker stop` 就走不到 index.ts 里「先交权再退」的那段。
CMD ["node", "dist/index.js"]
