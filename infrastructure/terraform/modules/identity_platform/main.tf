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
  # TODO: enable_email_link_signin
}

# F11 / ADR-031: MFA capability（多要素認証）はプロジェクトレベルの Identity Platform 設定に置く。
# （tenant リソースは GA provider v6 で mfa_config ブロックを持たないため、project config 側で設定する。）
# - state は env 変数で切替: 雛形/PoC は DISABLED〜ENABLED（任意登録）、本番導入ゲートで ENABLED。
# - エンフォースの単一ソースは IdP（ADR-026 思想）。未登録ユーザを enrollment へ誘導する判定はアプリ層。
# - 許可 factor（PHONE_SMS / TOTP）は導入時に確定（ADR-031 未確定事項）。
# count は enabled に従い、雛形段階は 0（apply されない）。
resource "google_identity_platform_config" "default" {
  count = var.enabled ? 1 : 0

  project = var.project_id

  mfa {
    state             = var.mfa_state
    enabled_providers = var.mfa_enabled_providers
  }
}
