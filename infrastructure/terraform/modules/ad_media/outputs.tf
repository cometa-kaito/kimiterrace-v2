output "bucket_name" {
  value       = var.enabled ? google_storage_bucket.ad_media[0].name : ""
  description = "作成した広告メディアバケット名（enabled=false 時は空）。"
}

output "public_base_url" {
  value       = var.enabled ? "https://storage.googleapis.com/${google_storage_bucket.ad_media[0].name}" : ""
  description = "公開オブジェクト URL の基底（<base>/<object key> で各画像にアクセス）。"
}
