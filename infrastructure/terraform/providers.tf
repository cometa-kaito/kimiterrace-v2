# google / google-beta provider 雛形
# 認証は Workload Identity Federation（CI）または gcloud ADC（ローカル）。
# service account JSON キーは使わない（CLAUDE.md ルール5）。

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}
