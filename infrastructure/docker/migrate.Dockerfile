# syntax=docker/dockerfile:1
#
# キミテラス v2 — DB migration runner image (Cloud Run Job 用)。
#
# 目的: private-IP-only な staging Cloud SQL (PostgreSQL 16 + pgvector) に対し、
# `@kimiterrace/db` の migration (drizzle/ + migrations/) を 1 回きりのバッチで適用する。
# private IP ゆえローカル機 (VPC 外) からは届かないので、VPC connector 経由で到達できる
# Cloud Run Job として実行する。エントリは packages/db の migrate-cli (= migrate-runner)。
#
# ビルド方法 (このリポジトリルートを build context にする):
#   gcloud builds submit \
#     --tag <image_repo_url>/migrate:<sha> \
#     -f infrastructure/docker/migrate.Dockerfile .
#   例 <image_repo_url> = asia-northeast1-docker.pkg.dev/signage-v2-staging/kimiterrace
#
# 実行時 env (Cloud Run Job 側で設定。値は Secret Manager 経由 = CLAUDE.md ルール5):
#   DATABASE_URL                   migrator (cloudsqlsuperuser) 接続文字列 (必須)
#   MIGRATE_GRANT_APP_ROLE_MEMBER  任意。設定すると migration 後 `GRANT kimiterrace_app TO <値>`
#                                  (staging では app login user `app`)。
#
# 注: このイメージは滅多にビルドしない one-off のため、サイズより**正しさ優先**。
# pnpm の node_modules は root の `.pnpm` 仮想ストアへの相対 symlink farm
# (`packages/db/node_modules/postgres -> ../../../node_modules/.pnpm/...`) なので、
# runtime には builder の `/app` ツリーを丸ごと持ち込み、symlink とその実体を同じ相対位置に
# 揃える (一部だけ copy すると symlink が dangling になり `postgres` を解決できない)。

# ---- builder: 依存解決 + tsc ビルド --------------------------------------------------
FROM node:22-slim AS builder

# pnpm をリポジトリ指定バージョンに固定 (packageManager: pnpm@11.4.0)。
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /app

# リポジトリ全体を context から取り込む (.dockerignore で node_modules/.git/dist 等を除外し
# context を絞る)。workspace manifest だけを先に COPY する最適化も可能だが、monorepo の
# manifest 列挙は壊れやすいので one-off では「全部 COPY → frozen install」を選ぶ (正しさ優先)。
COPY . .

# `@kimiterrace/db` とその依存 (workspace の `@kimiterrace/ai` 等) のみ install する。
# `...` (trailing) で db の依存パッケージも含める = tsc が解決すべき型/実体を揃える。
RUN pnpm install --frozen-lockfile --filter @kimiterrace/db...

# tsc -p tsconfig.build.json → packages/db/dist/ を生成 (migrate-cli.js / migrate-runner.js 等)。
# packages/db の tsconfig.build.json は incremental:false ＝ 古い .tsbuildinfo が context に紛れても
# 決定的にフルビルドする (部分 emit を排除。jobs.Dockerfile #657 と同規律)。
RUN pnpm --filter @kimiterrace/db build

# 部分ビルド / ソースアップロード欠落の回帰を **build 時に fail-fast** 検知する
# (jobs.Dockerfile の weather-job test・apps/web の standard_fonts test と同規律)。
# このイメージから起動する Cloud Run Job のエントリ (migrate-cli = CMD、seed-*-cli = command 上書き) が
# 1 つでも emit されていなければ image を作らせない (不完全 image をデプロイして runtime で
# MODULE_NOT_FOUND になるのを防ぐ。実害: kimiterrace-seed-ginan-ads の Cannot find module)。
#
# 個別ファイル名のハードコードは **新 CLI 追加時に追従漏れ** する (実際 seed-ginan-ads-cli は
# 並行 merge で後から増え、当初の固定リストから漏れた)。ゆえに src/*-cli.ts を起点に
# 対応する dist/*.js の存在を **網羅検査** し、将来の CLI 追加も自動でカバーする (drift-proof)。
RUN set -eu; \
    found=0; \
    for src in /app/packages/db/src/*-cli.ts; do \
      found=1; \
      js="/app/packages/db/dist/$(basename "$src" .ts).js"; \
      if [ ! -f "$js" ]; then \
        echo "FATAL: 部分ビルド検出 — $src に対応する $js が emit されていません" >&2; \
        exit 1; \
      fi; \
      echo "OK: $js"; \
    done; \
    [ "$found" -eq 1 ] || { echo "FATAL: src/*-cli.ts が 0 件 (アップロード欠落の疑い)" >&2; exit 1; }

# ---- runtime: 最小限の起動環境 -------------------------------------------------------
FROM node:22-slim AS runtime

# Cloud Run Job のデフォルト non-root 実行に備え、root 所有のままでも読めるよう普通に COPY する。
# WORKDIR = packages/db。migrate-cli の packageRoot 解決は import.meta.url から 2 階層上、
# すなわち dist/migrate-cli.js → /app/packages/db を指すので、drizzle/ と migrations/ は
# この WORKDIR 直下で見つかる。`postgres` は packages/db/node_modules/postgres (symlink) →
# /app/node_modules/.pnpm/postgres@.../node_modules/postgres で解決される。
WORKDIR /app/packages/db

# builder の /app を丸ごと持ち込む。これで:
#   - /app/node_modules/.pnpm/...                (symlink の実体)
#   - /app/packages/db/node_modules/postgres -> ../../../node_modules/.pnpm/... (symlink)
#   - /app/packages/db/dist, drizzle, migrations, package.json
# が同じ相対関係で揃い、Node の module 解決と asset 解決の両方が成立する。
# (COPY は symlink を symlink のまま保持するため、相対 symlink がそのまま有効。)
COPY --from=builder /app /app

ENV NODE_ENV=production

# 非 root で実行する (Semgrep dockerfile.security.missing-user / 最小権限・ルール5 の心構え)。
# node:22-slim 同梱の uid 1000 `node` ユーザー。migrate-cli は SQL ファイルの read と DB 接続のみで
# local への書込みが無いため、root 所有 (COPY 既定) の world-readable ツリーを read できれば足りる。
USER node

# package.json の "migrate:apply": "node dist/migrate-cli.js" と同じ起動。
# DATABASE_URL が無ければ migrate-cli が "DATABASE_URL required" を出して exit 1。
CMD ["node", "dist/migrate-cli.js"]
