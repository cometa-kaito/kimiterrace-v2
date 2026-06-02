output "network_id" {
  description = "VPC network ID（実体生成後に有効）"
  value       = try(google_compute_network.main[0].id, null)
}

output "network_self_link" {
  description = "VPC network self_link"
  value       = try(google_compute_network.main[0].self_link, null)
}

output "vpc_connector_id" {
  description = <<-EOT
    Serverless VPC Access connector の ID（実体生成後に有効）。
    cloud_run_job / cloud_run_job_weather の vpc_connector 入力に渡す。
  EOT
  value       = try(google_vpc_access_connector.serverless[0].id, null)
}

output "egress_ready" {
  description = <<-EOT
    外部 egress（Cloud NAT）が本モジュールで provision 済みかを示す signal。
    NAT が無いと ALL_TRAFFIC egress の Job は外部 API（JMA 等）へ到達できないため、
    外部 egress を要する job モジュールの enable-time precondition（external_egress_ready）に渡す。
    enabled = false（雛形）では NAT を作らないので false。
  EOT
  value       = length(google_compute_router_nat.egress) > 0
}
