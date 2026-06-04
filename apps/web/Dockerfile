# syntax=docker/dockerfile:1.7
#
# Cloud Run 用 Next.js 16 multi-stage build。
# Next.js の `output: "standalone"` を利用し、最小ランタイムだけ最終ステージにコピーする。
#
# build context は monorepo ルート想定:
#   docker build -f apps/web/Dockerfile -t kimiterrace-web .
#
# pnpm workspace は全 member の package.json が揃っていないと `--frozen-lockfile` が
# 「lockfile と不一致」で失敗する (apps/web は @kimiterrace/ai・db・observability に依存)。
# そのため surgical な個別 package.json COPY ではなく **whole-tree COPY**（.dockerignore で
# node_modules/.next/state を除外済）→ `--filter @kimiterrace/web...` で web のサブツリーだけ
# install/build する（migrate.Dockerfile と同方針＝正しさ優先）。

ARG NODE_VERSION=22-alpine

# ---------- builder: 依存解決 + Next.js build ----------
FROM node:${NODE_VERSION} AS builder
WORKDIR /repo

RUN corepack enable

# monorepo を丸ごと取り込む（context は .dockerignore で絞り込み済）。
COPY . .

# @kimiterrace/web とその依存サブツリー（ai / db / observability + 推移）だけ install。
RUN pnpm install --frozen-lockfile --filter @kimiterrace/web...

ARG GIT_COMMIT=dev
ENV GIT_COMMIT=${GIT_COMMIT}
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* は Next.js が **build 時**に client bundle へ inline する（Identity Platform web SDK 設定）。
# = build 引数で渡す必要がある。Firebase web apiKey はドメイン制限で保護される公開値＝secret ではない
# （ルール5 の対象外。サーバ側の機微情報は Secret Manager から runtime 注入する）。
ARG NEXT_PUBLIC_FIREBASE_API_KEY=""
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=""
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID=""
ENV NEXT_PUBLIC_FIREBASE_API_KEY=${NEXT_PUBLIC_FIREBASE_API_KEY}
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN}
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=${NEXT_PUBLIC_FIREBASE_PROJECT_ID}

# `...` で web の workspace 依存（ai / db / observability）も含めて build する。pnpm は recursive run を
# 依存順（deps 先）で実行するので、ai/db/observability の dist が先に生成され web が解決できる
# （`...` 無しだと web だけ build → `@kimiterrace/ai` の dist 不在で "Module not found")。
RUN pnpm --filter @kimiterrace/web... build

# ---------- runner: 本番イメージ（Next standalone）----------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 非 root ユーザーで実行
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Next standalone は outputFileTracingRoot=monorepoRoot ゆえ apps/web/server.js + node_modules + packages を内包。
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
