variable "project_id" {
  type        = string
  description = "GCP プロジェクト ID。"
}

variable "location" {
  type        = string
  default     = "asia-northeast1"
  description = "バケットのロケーション（単一リージョン、NFR07 データ越境ゼロ）。"
}

variable "env" {
  type        = string
  description = "環境名（labels 用、例: staging）。"
}

variable "enabled" {
  type        = bool
  default     = false
  description = "true で実体生成。雛形段階は false（count=0、非破壊）。"
}

variable "bucket_name" {
  type        = string
  default     = ""
  description = "バケット名。空なら <project_id>-ad-media。"
}

variable "force_destroy" {
  type        = bool
  default     = false
  description = "true でオブジェクトごと destroy 可（staging/dev は true 推奨、prod は false）。"
}

variable "versioning" {
  type        = bool
  default     = true
  description = "オブジェクトバージョニング。誤上書き復元用。"
}
