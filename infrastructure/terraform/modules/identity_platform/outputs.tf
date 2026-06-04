output "tenant_name" {
  description = "IDP tenant 名（create_tenant=true 時のみ）"
  value       = try(google_identity_platform_tenant.school[0].name, null)
}

# ── app build 用 Firebase web config（NEXT_PUBLIC_*・公開値）─────────────────
output "web_api_key" {
  description = "Identity Platform web SDK の apiKey（NEXT_PUBLIC_FIREBASE_API_KEY）。公開値だが provider が sensitive 扱い。未生成なら null。"
  value       = try(google_apikeys_key.web[0].key_string, null)
  sensitive   = true
}

output "auth_domain" {
  description = "Firebase Auth authDomain（NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN）。"
  value       = var.enabled ? "${var.project_id}.firebaseapp.com" : null
}

output "project_id" {
  description = "NEXT_PUBLIC_FIREBASE_PROJECT_ID（= GCP project）。"
  value       = var.project_id
}
