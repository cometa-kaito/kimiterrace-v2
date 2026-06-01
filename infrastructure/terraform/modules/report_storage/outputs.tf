output "bucket_name" {
  description = "月次レポートバケット名。reports Cloud Run Job の REPORT_BUCKET env に渡す。"
  value       = local.bucket_name
}

output "bucket_url" {
  description = "バケットの gs:// URL（実体生成後に有効）。"
  value       = try(google_storage_bucket.reports[0].url, null)
}
