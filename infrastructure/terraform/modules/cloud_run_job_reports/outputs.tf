output "job_name" {
  description = "Cloud Run Job 名"
  value       = var.job_name
}

output "runtime_service_account_email" {
  description = <<-EOT
    Job 実行 SA の email（実体生成後に有効）。**env root で report_storage モジュールの
    writer_service_account に渡す**ことで、当該バケット限定の objectAdmin（GCS 書込、ルール5 最小権限）を付与する。
  EOT
  value       = try(google_service_account.job_runtime[0].email, null)
}

output "scheduler_service_account_email" {
  description = "Cloud Scheduler の起動 SA の email（実体生成後に有効）"
  value       = try(google_service_account.scheduler[0].email, null)
}

output "scheduler_job_name" {
  description = "Cloud Scheduler ジョブ名（実体生成後に有効）"
  value       = try(google_cloud_scheduler_job.reports[0].name, null)
}
