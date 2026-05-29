# Cloud Run service 雛形（ADR-002 / ADR-008）
# TODO(Phase 開発): image, secrets, env vars, vpc connector, min/max instances 等を Phase 開発で確定する。
# 雛形段階は count = 0 で実体生成しない。

resource "google_cloud_run_v2_service" "web" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.service_name

  template {
    containers {
      image = var.image
      # TODO: ports, env, resources, startup_probe を埋める
    }
    # TODO: vpc_access, scaling, service_account を埋める
  }

  # TODO: traffic 設定（blue/green）
  # TODO: labels {"env" = var.env}
}

# 公開アクセス権 雛形（雛形段階は付与しない）
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count = 0 # TODO: 公開要件確定後に切替（IDP 経由のためそもそも不要かもしれない）

  project  = var.project_id
  location = var.region
  name     = var.service_name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
