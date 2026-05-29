# syntax=docker/dockerfile:1.7
#
# Cloud Run 用 Next.js 16 multi-stage build。
# Next.js の `output: "standalone"` を利用し、最小ランタイムだけ最終ステージにコピーする。
#
# build context は monorepo ルート想定:
#   docker build -f apps/web/Dockerfile -t kimiterrace-web .

ARG NODE_VERSION=22-alpine

# ---------- 1. deps: 依存解決 ----------
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo

RUN corepack enable

# monorepo の workspace ファイルをまとめてコピー（cache 効率最大化）
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json

RUN pnpm install --frozen-lockfile

# ---------- 2. builder: Next.js build ----------
FROM node:${NODE_VERSION} AS builder
WORKDIR /repo

RUN corepack enable

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/db ./packages/db

ARG GIT_COMMIT=dev
ENV GIT_COMMIT=${GIT_COMMIT}
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @kimiterrace/web build

# ---------- 3. runner: 本番イメージ ----------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 非 root ユーザーで実行
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
