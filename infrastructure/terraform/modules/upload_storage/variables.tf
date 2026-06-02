# upload_storage モジュール入力（F01 / #509 / #37, ADR-024, ルール8）

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "env" {
  description = "環境名 (prod/staging/dev)"
  type        = string
}

variable "enabled" {
  description = "実体生成スイッチ。雛形段階は false（リソースを作らない）。"
  type        = bool
  default     = false
}

variable "location" {
  description = "バケットのロケーション（NFR07 データ越境ゼロ: 単一リージョン）。"
  type        = string
  default     = "ASIA-NORTHEAST1"
}

variable "bucket_name" {
  description = "バケット名（GCS はグローバル一意）。空なら `<project_id>-teacher-uploads` を採用。upload 受口 Cloud Run の env に出力 bucket_name を渡す。"
  type        = string
  default     = ""
}

variable "force_destroy" {
  description = "中身があってもバケット削除を許すか。dev/staging は recreate 容易性優先で true、prod は false。"
  type        = bool
  default     = false
}

variable "versioning" {
  description = "オブジェクトバージョニング。教員の誤上書き/削除からの復元用に既定 on（生徒素材は原本保持を優先）。"
  type        = bool
  default     = true
}

variable "kms_key_name" {
  description = "CMEK 用 KMS CryptoKey のフルリソース名（任意）。空なら Google 管理鍵。生徒 PII 素材のため enabled 化時は顧客管理鍵を推奨。鍵 + IAM の Terraform 化は KMS module follow-up。"
  type        = string
  default     = ""
}

variable "log_bucket" {
  description = "アクセスログ出力先の既存ログ用バケット名（任意）。空ならアクセスログ無効。取得監査証跡用。"
  type        = string
  default     = ""
}

variable "coldline_after_days" {
  description = "この日数経過後に COLDLINE へ移送（抽出済み原本のコスト最適化。既定 90 日）。"
  type        = number
  default     = 90
}

variable "delete_after_days" {
  description = "この日数経過後に原本オブジェクトを削除（任意）。0 なら削除しない（既定: 原本保持優先）。"
  type        = number
  default     = 0
}

variable "writer_service_account" {
  description = "書込みを許す SA email（upload 受口 runtime SA）。空なら付与なし（雛形段階）。"
  type        = string
  default     = ""
}
