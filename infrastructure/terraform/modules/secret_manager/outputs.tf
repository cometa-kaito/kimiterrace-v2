output "secret_ids" {
  description = "作成済み secret の ID マップ（実体生成後に値が入る）"
  value       = { for k, s in google_secret_manager_secret.items : k => s.secret_id }
}
