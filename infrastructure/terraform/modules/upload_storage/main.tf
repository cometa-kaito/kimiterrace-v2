# 教員アップロード素材の Cloud Storage バケット（F01 / #509 / #37, ADR-024, ルール8）
#
# 教員がアップロードする校務文書・配布物・写真（PDF / docx / xlsx / PNG / JPEG）の保存先。
# 下流の抽出レイヤ（`packages/ai/src/extract/`, ADR-024）が pdfjs/mammoth/exceljs で
# 自プロセス内テキスト抽出し、画像はオプトインで Cloud Vision OCR にかける。
# 保存先 bucket は upload を扱う Cloud Run の env に `bucket_name` 出力を渡す（配線は follow-up）。
#
# 設計（CLAUDE.md ルール準拠 + ADR-024 脅威モデル）:
# - ルール5: uniform bucket-level access + public access prevention=enforced で公開を構造的に遮断。
#   書込みは upload 受口の runtime SA に `objectAdmin` を最小付与（var 経由・JSON キー不使用 = Workload Identity）。
# - ルール8: すべて Terraform 管理。雛形段階は enabled=false（count=0）で実体生成しない（report_storage 同規律）。
# - CMEK（任意・オプトイン）: kms_key_name が空でない時のみ顧客管理鍵で暗号化。空なら Google 管理鍵。
#   生徒 PII を含みうる素材（ADR-024 脅威モデル: 顔写真・氏名・成績）のため、enabled 化時に CMEK を
#   推奨（鍵 + IAM 配線は KMS module follow-up。現状はフックのみで非破壊。report_storage に既存 KMS
#   パターンが無いため新規 KMS リソースは作らず、外部の鍵名を受け取る配線に留める）。
# - アクセスログ（任意）: log_bucket が空でない時のみ既存ログ用バケットへアクセスログを出力。
#   誰がいつ生徒素材を取得したかの監査証跡（ルール1 の精神）。空なら無効。
# - ライフサイクル: 抽出後の原本は 10 年保管不要（抽出テキスト/構造化結果が下流の真実）。
#   COLDLINE 移送（既定 90 日）でコスト最適化し、delete_after_days（任意）で原本を期限削除可能に。
#   既定では削除しない（教員の再抽出・係争時の原本確認を優先、明示設定時のみ削除）。
# - NFR07（データ越境ゼロ）: location は単一リージョン asia-northeast1。
#
# スコープ外（follow-up）: CMEK 用 KMS key + key IAM の Terraform 化、upload 受口 Cloud Run/SA 配線、
# apps/web のアップロード導線（教員ロール限定）、ウイルススキャン。

locals {
  bucket_name = var.bucket_name != "" ? var.bucket_name : "${var.project_id}-teacher-uploads"
}

resource "google_storage_bucket" "uploads" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = local.bucket_name
  location = var.location

  # ルール5: 公開遮断 + 一様アクセス制御（ACL でなく IAM 一本化）。
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # 監査観点で誤削除を防ぐ（dev/staging は recreate 容易性優先で force_destroy=true、Issue #70 同規律）。
  force_destroy = var.force_destroy

  # オブジェクトバージョニング（既定 on）。教員が誤って上書き/削除した原本を復元可能にする。
  versioning {
    enabled = var.versioning
  }

  # CMEK（任意・オプトイン）。kms_key_name 指定時のみ顧客管理鍵で暗号化。
  # 空なら Google 管理鍵（dynamic で block ごと出さない = 非破壊・既存 plan 不変）。
  dynamic "encryption" {
    for_each = var.kms_key_name != "" ? [1] : []
    content {
      default_kms_key_name = var.kms_key_name
    }
  }

  # アクセスログ（任意）。log_bucket 指定時のみ既存ログ用バケットへアクセス/ストレージログを出力。
  dynamic "logging" {
    for_each = var.log_bucket != "" ? [1] : []
    content {
      log_bucket        = var.log_bucket
      log_object_prefix = "uploads-access"
    }
  }

  # 90 日後にコールド移送（派生抽出済みの原本はアクセス頻度が落ちる）。
  lifecycle_rule {
    condition {
      age = var.coldline_after_days
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  # 任意の原本削除（delete_after_days > 0 のときのみ）。既定 0 = 削除しない（原本保持優先）。
  dynamic "lifecycle_rule" {
    for_each = var.delete_after_days > 0 ? [1] : []
    content {
      condition {
        age = var.delete_after_days
      }
      action {
        type = "Delete"
      }
    }
  }

  labels = {
    env     = var.env
    feature = "f01-teacher-uploads"
  }
}

# 書込み SA（upload 受口の runtime SA）への最小権限: objectAdmin = 作成 + 上書き + 一覧。
# 雛形段階は writer 未設定（空）= 付与なし。upload 受口 SA 作成は follow-up（cloud_run 拡張）。
resource "google_storage_bucket_iam_member" "writer" {
  count = var.enabled && var.writer_service_account != "" ? 1 : 0

  bucket = google_storage_bucket.uploads[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${var.writer_service_account}"
}
