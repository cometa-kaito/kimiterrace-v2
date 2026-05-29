# VPC + Private Service Connection 雛形
# TODO(Phase 開発):
#   - サブネット定義（Cloud Run direct VPC egress 用）
#   - Cloud SQL 用の private service access (servicenetworking)
#   - firewall ルール（IAP 経由 SSH のみ等）

resource "google_compute_network" "main" {
  count = var.enabled ? 1 : 0

  project                 = var.project_id
  name                    = var.network_name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

# Private services access 用の予約レンジ（Cloud SQL Private IP 用）
resource "google_compute_global_address" "private_service_range" {
  count = var.enabled ? 1 : 0

  project       = var.project_id
  name          = "${var.network_name}-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main[0].id
}

# TODO: google_service_networking_connection, subnetworks, firewall を Phase 開発で追加
