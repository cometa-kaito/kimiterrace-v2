output "network_id" {
  description = "VPC network ID（実体生成後に有効）"
  value       = try(google_compute_network.main[0].id, null)
}

output "network_self_link" {
  description = "VPC network self_link"
  value       = try(google_compute_network.main[0].self_link, null)
}
