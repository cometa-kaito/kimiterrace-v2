# 月次レポート PDF の Cloud Storage バケット（F09 / #430 / #45, ルール8）
#
# apps/jobs の月次レポートバッチ（`apps/jobs/src/reports/run.ts` の persistAllMonthlyReports）が
# 生成 PDF を決定論 path `reports/{year}/{month2}/{schoolId}.pdf`（PR #465 規約）で保存する先。
# 保存先 bucket は Job の env `REPORT_BUCKET` で注入する（本モジュールの `bucket_name` 出力を渡す）。
#
# 設計（CLAUDE.md ルール準拠）:
# - ルール5: uniform bucket-level access + public access prevention=enforced で公開を構造的に遮断。
#   書込みは Job 専用 runtime SA に `objectAdmin` を最小付与（var 経由・JSON キー不使用 = Workload Identity）。
# - ルール8: すべて Terraform 管理。雛形段階は enabled=false（count=0）で実体生成しない（既存モジュール同規律）。
# - 90 日後にコールド移送（#430 受入: 派生データのコスト最適化。生成物は冪等に再生成可能）。
# - NFR07（データ越境ゼロ）: location は単一リージョン asia-northeast1。
#
# スコープ外（follow-up）: Cloud Scheduler + reports 用 Cloud Run Job 配線（cloud_run_job は現状
# embedding 専用）、apps/web の DL 導線（system_admin 限定）。

locals {
  bucket_name = var.bucket_name != "" ? var.bucket_name : "${var.project_id}-monthly-reports"
}

resource "google_storage_bucket" "reports" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = local.bucket_name
  location = var.location

  # ルール5: 公開遮断 + 一様アクセス制御（ACL でなく IAM 一本化）。
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # 監査観点で誤削除を防ぐ（dev/staging は recreate 容易性優先で force_destroy=true、Issue #70 同規律）。
  force_destroy = var.force_destroy

  versioning {
    enabled = var.versioning
  }

  # 90 日後にコールド移送（#430 受入）。
  lifecycle_rule {
    condition {
      age = var.coldline_after_days
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  labels = {
    env = var.env
  }
}

# 書込み SA（reports Job の runtime SA）への最小権限: objectAdmin = 作成 + 冪等上書き + 一覧。
# 雛形段階は writer 未設定（空）= 付与なし。reports Job の SA 作成は follow-up（cloud_run_job 拡張）。
resource "google_storage_bucket_iam_member" "writer" {
  count = var.enabled && var.writer_service_account != "" ? 1 : 0

  bucket = google_storage_bucket.reports[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${var.writer_service_account}"
}
