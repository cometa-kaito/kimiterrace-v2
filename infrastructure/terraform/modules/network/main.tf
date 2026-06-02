# VPC + Serverless egress（ADR-009 Terraform / ADR-021 閉域 egress / #94, #128）
#
# 役割: バックエンド（Cloud Run Job）が VPC 経由で egress するための土台を宣言的に管理する。
# ADR-021 の閉域原則を Terraform で強制する一次ソース:
#   - 外部 egress（JMA 等の public API）は **Cloud NAT という単一の出口経路だけ**から出す。
#     サイネージ端末・Server Component は自社 DB から読むだけで、外部に出ない（端末は connector を持たない）。
#   - Cloud SQL private IP（内部 egress）も同じ VPC connector を共有する。
#
# enabled = false の雛形段階は count = 0 で実体を作らない（plan 空・validate 緑）。
# enabled = true 化時に vpcaccess.googleapis.com / compute.googleapis.com の有効化が前提（Phase 開発）。
#
# TODO(Phase 開発, 本モジュールの egress 以外の残作業):
#   - google_service_networking_connection（Cloud SQL private IP の PSA peering、下の予約レンジを使用）
#   - firewall ルール（IAP 経由 SSH のみ等）
#   - 注: Cloud Run の VPC egress は **Serverless VPC Access connector** 方式を採る（下記）。
#     direct VPC egress（subnet + network_interfaces）は不採用（既存 job モジュールが connector を参照）。

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

# ── Serverless VPC Access connector ──────────────────────────────────
# Cloud Run Job（embedding / weather 等）が VPC へ egress するための connector。
# 内部 egress（Cloud SQL private IP, PRIVATE_RANGES_ONLY）と外部 egress（JMA, ALL_TRAFFIC）の両方が
# この connector を通る。外向きは下の Cloud NAT が出口になる（ADR-021 単一 egress 経路）。
# connector_cidr（/28）は VPC 内で他レンジ（PSA / 将来の subnet）と重複しないこと（Phase 開発で確定）。
resource "google_vpc_access_connector" "serverless" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  region  = var.region
  name    = var.connector_name

  network       = google_compute_network.main[0].name
  ip_cidr_range = var.connector_cidr

  machine_type  = var.connector_machine_type
  min_instances = var.connector_min_instances
  max_instances = var.connector_max_instances
}

# ── Cloud Router + Cloud NAT（外部 egress の単一出口）────────────────
# ADR-021 閉域原則: 外部 egress を開けるのは backend Job 経路だけ。その出口を Cloud NAT 1 つに集約し、
# 監査（NAT ロギング）と将来の FW 制御を 1 箇所で効かせる。端末は VPC connector を持たず外部に出ない。
resource "google_compute_router" "egress" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  region  = var.region
  name    = "${var.network_name}-egress-router"
  network = google_compute_network.main[0].id
}

resource "google_compute_router_nat" "egress" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  region  = var.region
  name    = "${var.network_name}-egress-nat"
  router  = google_compute_router.egress[0].name

  nat_ip_allocate_option = "AUTO_ONLY"
  # connector の暗黙 subnet を含む全 subnet レンジを NAT 対象にする（egress を 1 経路に集約）。
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  # egress 監査（ADR-021 / NFR07）。出口が 1 経路なので外向き通信の証跡をここに集約できる。
  log_config {
    enable = var.nat_logging_enabled
    filter = var.nat_logging_filter
  }
}
