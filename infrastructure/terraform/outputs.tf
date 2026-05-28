# 主要 output 雛形。
# 実体生成（count > 0）後に値が入る。雛形段階では参照のみ。

output "project_id" {
  description = "適用対象の GCP project ID"
  value       = var.project_id
}

output "region" {
  description = "適用対象のリージョン"
  value       = var.region
}

output "env" {
  description = "環境名"
  value       = var.env
}
