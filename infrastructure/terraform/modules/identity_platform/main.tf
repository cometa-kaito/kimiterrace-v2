# Identity Platform tenant 雛形（ADR-003）
# TODO(Phase 開発):
#   - tenant 単位で学校を分離するか、claims で分離するかは設計フェーズで確定
#   - SAML/OIDC provider 設定（県教委アカウント連携用）
# 雛形段階は count = 0。

# 認証は claims-based（school_id を custom claims で分離）＝**tenant 非使用が既定**（clientApp.ts も
# tenant を参照しない）。県教委 SAML/OIDC 連携等で tenant 分離が要る場合だけ create_tenant = true。
resource "google_identity_platform_tenant" "school" {
  count = var.enabled && var.create_tenant ? 1 : 0

  project               = var.project_id
  display_name          = var.tenant_display_name
  allow_password_signup = false
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

  # 職員（教員/管理者）は email/password ログイン（ADR-003 / F11）。生徒は magic link（アプリ層・IdP 非経由）。
  sign_in {
    allow_duplicate_emails = false
    email {
      enabled           = true
      password_required = true
    }

    # 電話番号サインインは不使用（職員=email/password、生徒=magic link）。API は phone_number ブロックを
    # 既定（enabled=false）で必ず返すため、config で明示しないと provider が毎回その除去（false -> null）を
    # plan する（恒久 drift）。意図（電話認証 OFF）を明示しつつ drift を解消する。
    phone_number {
      enabled = false
    }
  }

  mfa {
    state             = var.mfa_state
    enabled_providers = var.mfa_enabled_providers
  }

  # マルチテナント分離は不使用（claims-based が既定。create_tenant=true 時のみ tenant を作る）。
  # API は multi_tenant ブロックを既定（allow_tenants=false）で必ず返すため、config で明示しないと provider が
  # 毎回その除去（false -> null）を plan する（恒久 drift）。意図（tenant 分離 OFF）を明示しつつ drift を解消する。
  multi_tenant {
    allow_tenants = false
  }
}

# Identity Platform web SDK の apiKey（クライアント公開値）。Firebase Auth JS SDK が
# identitytoolkit（サインイン）+ securetoken（トークン更新）を叩くため両 API を target に許可する。
# **公開値＝secret ではない**（NEXT_PUBLIC_ で client bundle に載る。保護はドメイン制限 + バックエンド検証）。
# browser referrer 制限（allowed_referrers に Cloud Run URL）は B5 でドメイン確定後にハードニング（follow-up）。
resource "google_apikeys_key" "web" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  name         = "kimiterrace-web-${var.env}"
  display_name = "Identity Platform web SDK key (${var.env})"

  restrictions {
    api_targets {
      service = "identitytoolkit.googleapis.com"
    }
    api_targets {
      service = "securetoken.googleapis.com"
    }
  }
}
