output "job_name" {
  description = "Cloud Run Job 名（`gcloud run jobs execute <name>` で実行）。未生成なら null。"
  value       = try(google_cloud_run_v2_job.migrate[0].name, null)
}

output "runtime_service_account_email" {
  description = "migration Job の実行 SA email（未生成なら null）"
  value       = try(google_service_account.migrate_runtime[0].email, null)
}
