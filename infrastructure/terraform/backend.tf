# Remote state は GCS。
# bucket は手動で事前作成する（README の prerequisites を参照）。
# 暗号化は GCS デフォルト（CMEK は Phase 後半で導入予定）。
#
# 注意: backend 設定は変数を受け付けないため、env 切替は
#   `terraform init -backend-config=...` で bucket / prefix を上書きする。

terraform {
  backend "gcs" {
    bucket = "signage-v2-tf-state"
    prefix = "root"
  }
}
