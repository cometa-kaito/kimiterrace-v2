# syntax=docker/dockerfile:1
#
# キミテラス v2 — apps/jobs (Cloud Run Jobs) runner image。
#
# 目的: `apps/jobs` のバッチ（F14 天気取得 `src/weather/weather-job.ts` 等）を Cloud Run Job として
# 実行するためのイメージ。private-IP-only な Cloud SQL へは VPC connector 経由で到達し、外部 egress
# (JMA) は Cloud NAT 経由で出す（ADR-021 閉域原則・出口 1 経路）。エントリは Job ごとに
# command/args 上書きで切り替える（既定は天気取得 = weather-job）。
#
# ビルド方法 (リポジトリルートを build context にする):
#   gcloud builds submit \
#     --tag <image_repo_url>/jobs:<sha> \
#     -f infrastructure/docker/jobs.Dockerfile .
#   例 <image_repo_url> = asia-northeast1-docker.pkg.dev/signage-v2-staging/kimiterrace
#
# 実行時 env (Cloud Run Job 側で設定。値は Secret Manager 経由 = CLAUDE.md ルール5):
#   DATABASE_URL                kimiterrace_app ロール（非 BYPASSRLS）の DSN（必須）。
#                               天気 upsert は run.ts が system_admin context で行う（ルール2、BYPASSRLS 不使用）。
#   WEATHER_FETCH_USER_AGENT    任意。JMA への明示 UA（ADR-021 §HTTP マナー）。
#   WEATHER_FETCH_TIMEOUT_MS    任意。HTTP タイムアウト（既定 10000）。
#
# 注: migrate.Dockerfile と同方針 — one-off ゆえサイズより正しさ優先。pnpm の node_modules は root の
# `.pnpm` 仮想ストアへの相対 symlink farm なので、runtime には builder の `/app` ツリーを丸ごと持ち込み、
# symlink とその実体を同じ相対位置に揃える（一部だけ copy すると dangling になり解決できない）。

# ---- builder: 依存解決 + tsc ビルド --------------------------------------------------
FROM node:22-slim AS builder

# pnpm をリポジトリ指定バージョンに固定 (packageManager: pnpm@11.4.0)。
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /app

# リポジトリ全体を取り込む (.dockerignore で node_modules/.git/dist 等を除外)。
COPY . .

# `@kimiterrace/jobs` とその依存 (@kimiterrace/db / @kimiterrace/ai 等) のみ install。
# `...` (trailing) で依存パッケージも含め、tsc が解決すべき型/実体を揃える。
RUN pnpm install --frozen-lockfile --filter @kimiterrace/jobs...

# 依存（db / ai）→ jobs の順に build（pnpm は依存順に recursive run）。
#   - @kimiterrace/db / @kimiterrace/ai: dist を生成（runtime で jobs/dist が exports.default の dist を解決）。
#   - @kimiterrace/jobs: tsconfig.build.json で src → dist へ emit（dist/weather/weather-job.js 等）。
RUN pnpm --filter @kimiterrace/jobs... build

# 部分ビルド / ソースアップロード欠落の回帰を **build 時に fail-fast** 検知する
# （apps/web/Dockerfile の standard_fonts test・migrate.Dockerfile の *-cli.ts 網羅ループと同規律）。
# weather-job が emit されていなければ image を作らせない（不完全 image をデプロイして runtime で
# MODULE_NOT_FOUND になるのを防ぐ）。
RUN test -f /app/apps/jobs/dist/weather/weather-job.js

# F06 embedding バッチ（ADR-038、生徒/保護者 Q&A の知識源）も同イメージから
# `dist/embedding/embed-job.js` を起動する（Cloud Run Job の args 上書き）。weather と同様、部分ビルドで
# 当該 entry が欠落したまま image を作らせない（runtime で MODULE_NOT_FOUND になる前に build を fail させる）。
RUN test -f /app/apps/jobs/dist/embedding/embed-job.js

# 推移依存 @kimiterrace/db の dist も検証する（defense-in-depth、feedback_cloudbuild_tsbuildinfo_partial_emit）。
# jobs runtime は `@kimiterrace/db` の `.` バレル（= dist/index.js。これが dist/schema/index.js と
# dist/queries/*.js を再エクスポートする）を解決するため、db 側の部分 emit でも runtime で MODULE_NOT_FOUND に
# なりうる。jobs は db CLI を起動しない（CLI は migrate image の関心事）ので migrate.Dockerfile の *-cli.ts
# ループでなく、runtime 解決の起点 2 点を検証する＝ barrel エントリ + 別ディレクトリの schema/index.js
# （後者は部分 emit で最も欠落しやすい subtree の代表）。node:22-slim の /bin/sh は dash ゆえ
# set -eu / [ ] / >&2 / exit 1 で書く。
RUN set -eu; \
    for js in /app/packages/db/dist/index.js /app/packages/db/dist/schema/index.js; do \
      [ -f "$js" ] || { echo "FATAL: 部分ビルド検出 — @kimiterrace/db の $js が emit されていません" >&2; exit 1; }; \
      echo "OK: $js"; \
    done

# ---- runtime: 最小限の起動環境 -------------------------------------------------------
FROM node:22-slim AS runtime

# WORKDIR = apps/jobs。weather-job は dist/weather/weather-job.js（command/args は Cloud Run Job 側で上書き）。
WORKDIR /app/apps/jobs

# builder の /app を丸ごと持ち込む（symlink farm と実体を同じ相対位置で揃える）。
COPY --from=builder /app /app

ENV NODE_ENV=production

# 非 root で実行する（最小権限・Semgrep dockerfile.security.missing-user）。
# weather-job は HTTP 取得 + DB upsert のみで local 書込みが無いため、root 所有の world-readable
# ツリーを read できれば足りる。node:22-slim 同梱の uid 1000 `node` ユーザー。
USER node

# 既定エントリ = 天気取得 Job。他 Job は Cloud Run Job 定義の command/args 上書きで切替（seed の前例と同様）。
CMD ["node", "dist/weather/weather-job.js"]
