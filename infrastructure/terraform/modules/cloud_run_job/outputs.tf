output "job_name" {
  description = "Cloud Run Job 名"
  value       = var.job_name
}

output "runtime_service_account_email" {
  description = "Job 実行 SA の email（実体生成後に有効）。secret_manager.accessor_service_account 等に渡す。"
  value       = try(google_service_account.job_runtime[0].email, null)
}

output "scheduler_service_account_email" {
  description = "Cloud Scheduler の起動 SA の email（実体生成後に有効）"
  value       = try(google_service_account.scheduler[0].email, null)
}

output "scheduler_job_name" {
  description = "Cloud Scheduler ジョブ名（実体生成後に有効）"
  value       = try(google_cloud_scheduler_job.embedding[0].name, null)
}
