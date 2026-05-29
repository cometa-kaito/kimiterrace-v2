# Identity Platform tenant 雛形（ADR-003）
# TODO(Phase 開発):
#   - tenant 単位で学校を分離するか、claims で分離するかは設計フェーズで確定
#   - SAML/OIDC provider 設定（県教委アカウント連携用）
# 雛形段階は count = 0。

resource "google_identity_platform_tenant" "school" {
  count = var.enabled ? 1 : 0

  project               = var.project_id
  display_name          = var.tenant_display_name
  allow_password_signup = false
  # TODO: enable_email_link_signin, mfa_config
}
