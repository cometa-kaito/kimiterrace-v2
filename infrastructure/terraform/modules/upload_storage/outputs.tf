output "bucket_name" {
  description = "教員アップロードバケット名。upload 受口 Cloud Run の env に渡す。"
  value       = local.bucket_name
}

output "bucket_url" {
  description = "バケットの gs:// URL（実体生成後に有効、enabled=false 時は null）。"
  value       = try(google_storage_bucket.uploads[0].url, null)
}
