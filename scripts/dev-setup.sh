#!/usr/bin/env bash
# ローカル開発環境を 1 コマンドで立ち上げる。
#
# やること:
#   1. .env が無ければ .env.example からコピー
#   2. docker compose で postgres (pgvector) を起動
#   3. ヘルスチェック通過まで待機
#   4. pgvector 拡張を有効化
#
# 使い方:
#   ./scripts/dev-setup.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infrastructure/docker/docker-compose.dev.yml"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"
ENV_FILE="${REPO_ROOT}/.env"

log() { printf '\033[1;36m[dev-setup]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[dev-setup]\033[0m %s\n' "$*" >&2; }

# --- 1. .env 準備 ---
if [[ ! -f "${ENV_FILE}" ]]; then
  log ".env が無いので .env.example からコピーします"
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
else
  log ".env は既に存在します（上書きしません）"
fi

# --- 2. docker 起動 ---
if ! command -v docker >/dev/null 2>&1; then
  err "docker が見つかりません。Docker Desktop をインストールしてください。"
  exit 1
fi

log "PostgreSQL (pgvector) を起動します"
docker compose -f "${COMPOSE_FILE}" up -d

# --- 3. ヘルスチェック待機 ---
log "PostgreSQL の起動を待機します"
for i in {1..30}; do
  if docker compose -f "${COMPOSE_FILE}" exec -T postgres pg_isready -U postgres -d kimiterrace_dev >/dev/null 2>&1; then
    log "PostgreSQL が起動しました"
    break
  fi
  if [[ $i -eq 30 ]]; then
    err "PostgreSQL がタイムアウト時間内に起動しませんでした"
    docker compose -f "${COMPOSE_FILE}" logs postgres
    exit 1
  fi
  sleep 1
done

# --- 4. pgvector 拡張 ---
log "pgvector 拡張を有効化します"
docker compose -f "${COMPOSE_FILE}" exec -T postgres \
  psql -U postgres -d kimiterrace_dev -c "CREATE EXTENSION IF NOT EXISTS vector;"

log "完了。接続情報は .env (DATABASE_URL) を参照してください。"
