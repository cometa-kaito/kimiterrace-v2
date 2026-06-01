# Cloud Logging exclusion 雛形（#439 / ADR-016 補完 / CLAUDE.md ルール5・NFR03）
#
# F05 magic link の入口 `GET /s/{token}` は bearer credential であるトークンを URL パスで受ける。
# アプリ層はトークンをログに出さない（route.ts / token.ts, ルール5）が、Cloud Run / 外部 HTTP(S) LB の
# request log は `httpRequest.requestUrl` を既定で記録するため、トークンが平文で Cloud Logging に滞留し、
# ログ閲覧権を持つ内部者が保持期間中に live トークンを収集して生徒ビューへなりすませる余地が残る
# （ADR-016 が明示的に扱っていない infra 経路）。
#
# 対策: `/s/{token}` の request log エントリを既定バケットへ取り込む前に除外する。生徒アクセスの
# 利用監査はアプリ層が DB（events / audit_log, recordStudentAccess）に role=student + 解決校で記録
# しているため、この HTTP access log の欠落は監査要件（ルール1）を損なわない。
#
# 雛形段階は enabled=false。Phase 開発で Cloud Run / LB の実体生成と同時に true へ切替える。

resource "google_logging_project_exclusion" "magic_link_token_paths" {
  count = var.enabled ? 1 : 0

  project     = var.project_id
  name        = "exclude-magic-link-token-access-logs-${var.env}"
  description = "Drop /s/{token} HTTP request logs so F05 magic-link bearer tokens (ADR-016) are not retained in Cloud Logging; app-level access audit lives in the DB (#439)."

  # Cloud Run（run.googleapis.com/requests）と外部 HTTP(S) LB（http_load_balancer）の request log のうち、
  # ホスト直下 /s/<token> に一致するものだけを除外する。`://[^/]+/s/` はホスト境界の直後に /s/ が来る場合
  # のみ一致するため、/students 等の別パスや /admin/s/... のような下位階層は対象外。
  filter = "(log_id(\"run.googleapis.com/requests\") OR resource.type=\"http_load_balancer\") AND httpRequest.requestUrl=~\"://[^/]+/s/\""
}
