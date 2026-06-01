# report_storage モジュール入力（F09 / #430 / ルール8）

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
  description = "バケット名（GCS はグローバル一意）。空なら `<project_id>-monthly-reports` を採用。Job の REPORT_BUCKET env に出力 bucket_name を渡す。"
  type        = string
  default     = ""
}

variable "force_destroy" {
  description = "中身があってもバケット削除を許すか。dev/staging は recreate 容易性優先で true、prod は false。"
  type        = bool
  default     = false
}

variable "versioning" {
  description = "オブジェクトバージョニング。バッチは同 path を冪等上書きするため既定 off（必要なら有効化）。"
  type        = bool
  default     = false
}

variable "coldline_after_days" {
  description = "この日数経過後に COLDLINE へ移送（#430 受入: 既定 90 日）。"
  type        = number
  default     = 90
}

variable "writer_service_account" {
  description = "書込みを許す SA email（reports Job runtime SA）。空なら付与なし（雛形段階）。"
  type        = string
  default     = ""
}
