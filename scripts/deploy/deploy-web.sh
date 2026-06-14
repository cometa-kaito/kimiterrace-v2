#!/usr/bin/env bash
#
# scripts/deploy/deploy-web.sh — web（Next.js / Cloud Run）の【日常コードデプロイ】を 1 コマンドに束ねる。
#
# これは「初期構築(bring-up)」ではない。bring-up（2-phase apply / secret 投入 / seed Job）は
# docs/runbooks/prod-bringup-cutover.md。日常デプロイの全体像は docs/runbooks/web-deploy.md。
#
# やること（schema 無変更の通常デプロイ）:
#   ① image build & push   … infrastructure/docker/cloudbuild-web.yaml を Cloud Build で実行
#   ② tag bump             … envs/<env>/main.tf の local.web_image_tag を <sha> へ書き換え（作業ツリーのみ）
#   ③ apply                … terraform apply -target=module.cloud_run（--apply 指定時のみ）
#   ④ 疎通確認             … /api/health 200 + /login の cache-control（force-dynamic 退行チェック）
#
# 安全既定（fail-safe）:
#   - 非対話で動く（read プロンプトなし＝Claude の Bash からも hang しない）。実行範囲は flag で制御。
#   - 既定は build + bump + `terraform plan` まで。**apply はしない**。実際に Cloud Run を更新するには
#     `--apply` を明示する（apply は --apply 指定時のみ到達。これが唯一の hard gate）。
#     prod の場合はさらに反映前に警告を出す（取り違え事故の speed-bump。非対話設計ゆえ read 確認は使わない）。
#   - tag bump は作業ツリーの main.tf を編集するだけ。git commit / push はしない（ルール6/8: infra 変更は
#     PR 経由が原則。apply は作業ツリーの値で効くので、commit/PR は後追いでよい）。
#
# 使い方:
#   scripts/deploy/deploy-web.sh staging               # build + bump + plan（apply しない）
#   scripts/deploy/deploy-web.sh staging --apply        # build + bump + apply + verify
#   scripts/deploy/deploy-web.sh prod --apply           # prod 反映（要 --apply）
#   scripts/deploy/deploy-web.sh staging <sha> --skip-build --apply  # 既に build 済 image を bump+apply
#   scripts/deploy/deploy-web.sh prod --verify-only      # 反映済みの prod を疎通確認だけ
#
# 引数:
#   $1            staging | prod （必須）
#   $2            git sha（任意・既定 = HEAD short-7）。`--` 始まりは flag として扱う。
# flags:
#   --apply       terraform apply まで実行（既定は plan で停止）
#   --skip-build  image build をスキップ（既に AR に push 済の sha を bump+apply するとき）
#   --verify-only 疎通確認だけ実行（build/bump/apply はしない）
#
set -euo pipefail

err() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
note() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }

# --- リポジトリルートへ ---------------------------------------------------------
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# --- 引数パース ----------------------------------------------------------------
ENV="${1:-}"
[ -n "$ENV" ] || err "第1引数に環境 (staging|prod) を指定してください。例: scripts/deploy/deploy-web.sh staging --apply"
shift || true

SHA=""
DO_APPLY=0
SKIP_BUILD=0
VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --apply)       DO_APPLY=1 ;;
    --skip-build)  SKIP_BUILD=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    --*)           err "未知のオプション: $arg" ;;
    *)             SHA="$arg" ;;
  esac
done
[ -n "$SHA" ] || SHA="$(git rev-parse --short=7 HEAD)"

# --- 環境別設定（bash 3.2 / Mac worker 互換のため case で分岐・連想配列を使わない）-----------
case "$ENV" in
  staging)
    PROJECT="signage-v2-staging"
    PROJ_NUM="33826309713"
    REPO="asia-northeast1-docker.pkg.dev/signage-v2-staging/kimiterrace"
    AUTH_DOMAIN="signage-v2-staging.firebaseapp.com"
    APP_URL="https://kimiterrace-web-5wkl3il5zq-an.a.run.app"
    VERIFY_BASE="https://kimiterrace-web-5wkl3il5zq-an.a.run.app"
    ;;
  prod)
    PROJECT="signage-v2-prod"
    PROJ_NUM="1003674206308"
    REPO="asia-northeast1-docker.pkg.dev/signage-v2-prod/kimiterrace"
    AUTH_DOMAIN="signage-v2-prod.firebaseapp.com"
    APP_URL="https://app.school-signage.net"
    VERIFY_BASE="https://app.school-signage.net"
    ;;
  *)
    err "環境は staging か prod のみ（指定: $ENV）"
    ;;
esac
TF_DIR="infrastructure/terraform/envs/${ENV}"
MAINTF="${TF_DIR}/main.tf"
SA="projects/${PROJECT}/serviceAccounts/${PROJ_NUM}-compute@developer.gserviceaccount.com"

# --- 疎通確認（共通関数）-------------------------------------------------------
verify() {
  note "疎通確認 (${VERIFY_BASE})"
  local code hdr
  code="$(curl -fsS -o /dev/null -w '%{http_code}' "${VERIFY_BASE}/api/health" || echo "ERR")"
  printf '  /api/health -> %s  (期待: 200)\n' "$code"
  hdr="$(curl -fsS -I "${VERIFY_BASE}/login" 2>/dev/null || true)"
  printf '%s\n' "$hdr" | grep -i -E 'cache-control|x-nextjs-prerender' | sed 's/^/  /' || true
  if printf '%s\n' "$hdr" | grep -qi 's-maxage'; then
    warn "/login が静的キャッシュ(s-maxage)化している可能性。DB 状態依存の public ページは force-dynamic 必須"
    warn "  → ref: docs/runbooks/web-deploy.md「地雷チェックリスト」/ memory ref_idp_password_floor_and_login_static_cache"
  fi
}

if [ "$VERIFY_ONLY" = "1" ]; then
  verify
  exit 0
fi

# --- 地雷プリフライト（毎回 echo して踏み忘れを防ぐ）---------------------------
cat <<EOF

============================================================
 web deploy: env=${ENV}  sha=${SHA}
 project=${PROJECT}  repo=${REPO}
 apply=$([ "$DO_APPLY" = 1 ] && echo YES || echo "NO (plan のみ)")  skip-build=$([ "$SKIP_BUILD" = 1 ] && echo YES || echo NO)
------------------------------------------------------------
 ⚑ 反映前チェック（docs/runbooks/web-deploy.md 参照）:
   - DB 状態依存の public ページに force-dynamic が付いているか（s-maxage 退行）
   - schema を変えたか → Yes なら本スクリプト不可。migrate_image_tag bump + migrate Job が必要
   - secret を増減したか → Yes なら別途 gcloud secrets versions add + 全モジュール apply
   - prod 広告 media_url は staging バケット参照（差し替えは staging 側）
============================================================
EOF

# prod apply 時は取り違え事故防止の speed-bump として警告を出す（hard gate は --apply 自体）
if [ "$ENV" = "prod" ] && [ "$DO_APPLY" = "1" ]; then
  warn "prod に対して apply します（本番 Cloud Run revision が切替わります）。"
fi

# --- ① build & push ------------------------------------------------------------
if [ "$SKIP_BUILD" = "1" ]; then
  note "build スキップ（既存 image ${REPO}/web:${SHA} を使用）"
else
  note "① Cloud Build で web image を build & push (${REPO}/web:${SHA})"
  FIREBASE_API_KEY="$(terraform -chdir="${TF_DIR}" output -raw firebase_api_key)"
  [ -n "$FIREBASE_API_KEY" ] || err "terraform output firebase_api_key が空。${TF_DIR} で terraform init 済か / ADC 認証を確認"

  # cloudbuild-web.yaml の default は staging 値。prod はここで override する。
  SUBS="_SHA=${SHA},_FIREBASE_API_KEY=${FIREBASE_API_KEY}"
  if [ "$ENV" = "prod" ]; then
    SUBS="${SUBS},_AUTH_DOMAIN=${AUTH_DOMAIN},_PROJECT_ID=${PROJECT},_REPO=${REPO},_APP_URL=${APP_URL}"
  fi

  gcloud builds submit . \
    --project="${PROJECT}" \
    --config=infrastructure/docker/cloudbuild-web.yaml \
    --service-account="${SA}" \
    --substitutions="${SUBS}"
fi

# --- ② tag bump（作業ツリーの main.tf を書き換え）-------------------------------
note "② ${MAINTF} の web_image_tag を ${SHA} へ bump"
CUR="$(grep -E '^[[:space:]]*web_image_tag[[:space:]]*=' "${MAINTF}" | head -1 | sed -E 's/.*"([^"]*)".*/\1/')"
if [ "$CUR" = "$SHA" ]; then
  note "  既に web_image_tag = \"${SHA}\"（変更なし）"
else
  TMP="$(mktemp)"
  # 行頭（空白のみ可）の web_image_tag 代入だけを置換。コメント中の言及(# ...)は行頭が # なので無傷。
  # sha だけでなく **行末コメントも毎回 stub に刷新**する（旧コメントは前回デプロイの説明＝そのまま残すと
  # 実態と矛盾する papercut の温床。2026-06-14 prod #878 で実害）。日付は自動採取せず（誤りの温床）、
  # 正確なデプロイ内容は ⑤ の PR/commit で書く運用。stub は env+sha の最小限に留める。
  sed -E "s|^([[:space:]]*web_image_tag[[:space:]]*=[[:space:]]*\")[^\"]*(\").*|\1${SHA}\2 # ${ENV} deploy ${SHA}（内容は PR/commit に記述）|" "${MAINTF}" > "${TMP}" && mv "${TMP}" "${MAINTF}"
  NEW="$(grep -E '^[[:space:]]*web_image_tag[[:space:]]*=' "${MAINTF}" | head -1 | sed -E 's/.*"([^"]*)".*/\1/')"
  [ "$NEW" = "$SHA" ] || err "tag bump 失敗（${MAINTF} の web_image_tag が ${SHA} になっていない）"
  note "  ${CUR} -> ${NEW}（行末コメントは stub に刷新。⑤ PR/commit でこの回の内容を正書きすること）"
fi

# --- ③ plan / apply ------------------------------------------------------------
if [ "$DO_APPLY" = "1" ]; then
  note "③ terraform apply -target=module.cloud_run (${ENV})"
  terraform -chdir="${TF_DIR}" apply -target=module.cloud_run -input=false -auto-approve
  verify
  cat <<EOF

✅ deploy 完了（env=${ENV} sha=${SHA}）。
   残作業: web_image_tag の bump を PR でコミットしてください（infra 変更は記録を残す）:
     - main.tf の web_image_tag 行末コメントは stub（"${ENV} deploy ${SHA}…"）。
       この回のデプロイ内容（#NNN / schema・secret 変更有無 / 疎通結果）に書き換えてから commit する。
     git add ${MAINTF}
     git commit -m "feat(infra): ${ENV} web を ${SHA} へ bump（#NNN 反映）"
EOF
else
  note "③ terraform plan -target=module.cloud_run (${ENV}) — apply はしません"
  terraform -chdir="${TF_DIR}" plan -target=module.cloud_run -input=false
  cat <<EOF

ℹ️ plan のみ実行。実際に反映するには:
     scripts/deploy/deploy-web.sh ${ENV} ${SHA} --skip-build --apply
EOF
fi
