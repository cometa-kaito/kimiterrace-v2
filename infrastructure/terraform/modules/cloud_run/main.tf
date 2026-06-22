# Cloud Run service（B5 / app デプロイ。ADR-002 / ADR-008）
#
# 対象: apps/web（Next.js 16 standalone）。Identity Platform の claims ベース認証は **app が自前で行う**
# ため、Cloud Run 側は未認証 invoker（allUsers）を許可し、認可は app の middleware + Server 側
# withSession（RLS context・lib/db.ts）が最終防衛線として担う。
#
# 設計（CLAUDE.md ルール準拠）:
# - ルール2: app は private-IP-only な Cloud SQL に VPC connector 経由で到達する（egress=PRIVATE_RANGES_ONLY）。
#   DATABASE_URL は **app login user**（テーブル非所有 → SET LOCAL ROLE kimiterrace_app で RLS が実効）の DSN。
#   migrator（テーブル所有）では繋がない。
# - ルール4/5: DATABASE_URL は Secret Manager から注入（ハードコード禁止）。runtime SA は当該 DSN secret のみ
#   accessor（最小権限）。Vertex AI（roles/aiplatform.user）と Identity Platform 管理
#   （roles/identitytoolkit.admin）はプロジェクト自身のリソースに限定。JSON キーは使わない（Workload Identity）。
# - ルール8: すべて Terraform 管理。
#
# 雛形段階は enabled = false（count = 0）。

# 実行用 SA（Workload Identity・JSON キー禁止、ルール5）。
resource "google_service_account" "web_runtime" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  account_id   = "${var.service_name}-sa"
  display_name = "Cloud Run web service runtime SA (${var.env})"
  description  = "Cloud Run (web) の実行 SA。DATABASE_URL secret accessor + Vertex AI user + Identity Platform admin（最小権限、ルール5）。"
}

# DATABASE_URL secret の accessor（**該当 secret のみ** = 最小権限、ルール5）。
resource "google_secret_manager_secret_iam_member" "runtime_database_url" {
  count = var.enabled && var.database_url_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.database_url_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web_runtime[0].email}"
}

# TV_POLL_SECRET secret の accessor（**該当 secret のみ** = 最小権限、ルール5）。
# F15/ADR-022: TV ポーリング（/api/tv/config・/api/tv/lp-config）の共有シークレット。空文字なら配線しない。
resource "google_secret_manager_secret_iam_member" "runtime_tv_poll_secret" {
  count = var.enabled && var.tv_poll_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.tv_poll_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web_runtime[0].email}"
}

# SWITCHBOT_WEBHOOK_SECRET secret の accessor（**該当 secret のみ** = 最小権限、ルール5）。
# F13/ADR-020: 人感センサ presence 受信 /api/sensors/switchbot/webhook の共有シークレット。
# cutover 設計で値は TV_POLL_SECRET と同値ゆえ prod は同じ secret を流用する。その場合 accessor は
# runtime_tv_poll_secret が既に付与済みのため**重複付与を避けて配線しない**（別 secret を指す時のみ付与）。
resource "google_secret_manager_secret_iam_member" "runtime_switchbot_webhook_secret" {
  count = var.enabled && var.switchbot_webhook_secret_id != "" && var.switchbot_webhook_secret_id != var.tv_poll_secret_id ? 1 : 0

  project   = var.project_id
  secret_id = var.switchbot_webhook_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web_runtime[0].email}"
}

# PROVISION_AGENT_SECRET secret の accessor（**該当 secret のみ** = 最小権限、ルール5）。
# C方式 TV プロビジョニング: /api/tv/provisioning/* の agent 認証用 専用 secret（PR4）。空文字なら配線しない。
resource "google_secret_manager_secret_iam_member" "runtime_provision_agent_secret" {
  count = var.enabled && var.provision_agent_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.provision_agent_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web_runtime[0].email}"
}

# PARTNER_API_SECRET secret の accessor（**該当 secret のみ** = 最小権限、ルール5）。
# Partner API（portal ↔ v2 K1 効果メトリクス pull /api/partner/*）の共有シークレット。空文字なら配線しない。
resource "google_secret_manager_secret_iam_member" "runtime_partner_api_secret" {
  count = var.enabled && var.partner_api_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.partner_api_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web_runtime[0].email}"
}

# DEV_LOGIN_CONFIG secret の accessor（**該当 secret のみ** = 最小権限、ルール5）。
# staging 限定 dev-login（apps/web/app/api/dev-login）のゲート鍵 + 任意の解決ヒント（password は持たない）。空文字なら
# 配線しない（= prod は accessor を付与せず env も注入しない＝dev-login は config 不在で常に 404）。
resource "google_secret_manager_secret_iam_member" "runtime_dev_login_secret" {
  count = var.enabled && var.dev_login_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.dev_login_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web_runtime[0].email}"
}

# staging 限定 dev-login の createCustomToken（パスワードレス セッション発行）に必要な signBlob 権限。
# web 実行 SA が「自分自身」に対して serviceAccountTokenCreator を持つ（鍵ファイル無しの自己署名）。
# dev_login_secret_id が空（= prod）なら付与しない＝prod では custom token 発行が原理的に不能（多層防御の追加層）。
resource "google_service_account_iam_member" "runtime_dev_login_token_creator" {
  count = var.enabled && var.dev_login_secret_id != "" ? 1 : 0

  service_account_id = google_service_account.web_runtime[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.web_runtime[0].email}"
}

# Vertex AI 呼び出し（F03 抽出 / F06 生徒 Q&A / F08 効果コメントの Gemini）。project レベル
# roles/aiplatform.user。送信前 PII マスキングは app 側（ルール4）。
resource "google_project_iam_member" "runtime_vertex_user" {
  count = var.enabled && var.grant_vertex_user ? 1 : 0

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.web_runtime[0].email}"
}

# Identity Platform 管理 API（firebase-admin）。session.ts の verifyIdToken(checkRevoked=true) は
# 認証済みリクエスト毎に Identity Toolkit を照会し、F11 アカウント管理（create/update/revoke）も同 API
# を叩く。これが無いと**認証済みリクエストが全滅**するため app 機能上必須（プロジェクト自身の IdP に限定）。
resource "google_project_iam_member" "runtime_identitytoolkit_admin" {
  count = var.enabled && var.grant_identity_platform_admin ? 1 : 0

  project = var.project_id
  role    = "roles/identitytoolkit.admin"
  member  = "serviceAccount:${google_service_account.web_runtime[0].email}"
}

resource "google_cloud_run_v2_service" "web" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.service_name

  # 削除保護。prod は既定 true、staging/dev は env 側で false に上書き（Issue #70 同方針）。
  deletion_protection = var.deletion_protection

  # ingress=all（外部公開）。app が自前認証ゆえ未認証到達を許可し、認可は app 側（middleware + withSession）。
  ingress = "INGRESS_TRAFFIC_ALL"

  labels = {
    env = var.env
  }

  template {
    service_account = google_service_account.web_runtime[0].email

    scaling {
      min_instance_count = var.min_instances # 0 = scale-to-zero（アイドル課金なし）
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      # apps/web/Dockerfile は ENV PORT=3000 / CMD node apps/web/server.js（Next standalone は $PORT を尊重）。
      # container_port を指定すると Cloud Run が PORT を一致させて注入するため 3000 で配線する。
      ports {
        container_port = var.container_port
      }

      # DATABASE_URL = app DSN（Secret Manager 注入、ルール5・ハードコード禁止）。
      dynamic "env" {
        for_each = var.database_url_secret_id != "" ? [1] : []
        content {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = var.database_url_secret_id
              version = "latest"
            }
          }
        }
      }

      # TV_POLL_SECRET = TV ポーリング共有シークレット（Secret Manager 注入、ルール5）。
      # F15/ADR-022: /api/tv/config・/api/tv/lp-config の認証。未設定なら poll route は fail-closed(401)。
      dynamic "env" {
        for_each = var.tv_poll_secret_id != "" ? [1] : []
        content {
          name = "TV_POLL_SECRET"
          value_source {
            secret_key_ref {
              secret  = var.tv_poll_secret_id
              version = "latest"
            }
          }
        }
      }

      # SWITCHBOT_WEBHOOK_SECRET = 人感センサ presence 受信の共有シークレット（Secret Manager 注入、ルール5）。
      # F13/ADR-020: /api/sensors/switchbot/webhook の認証。未設定なら webhook route は fail-closed(401)＝
      # presence を一切記録しない。値は cutover 設計上 TV_POLL_SECRET と同値（prod は同じ secret を流用）。
      dynamic "env" {
        for_each = var.switchbot_webhook_secret_id != "" ? [1] : []
        content {
          name = "SWITCHBOT_WEBHOOK_SECRET"
          value_source {
            secret_key_ref {
              secret  = var.switchbot_webhook_secret_id
              version = "latest"
            }
          }
        }
      }

      # TV_POLL_SECRET_LEGACY = ゼロダウンタイム鍵ローテの移行期のみ受理する旧キー（Secret Manager 注入、ルール5）。
      # 同一 secret(tv_poll_secret_id) の旧バージョンをピン留め。空文字なら配線しない（単一キー運用＝従来挙動）。
      # 全 TV 端末を新キーへ更新後に legacy_version を "" へ戻して apply すれば旧キーは無効化される。
      dynamic "env" {
        for_each = var.tv_poll_secret_id != "" && var.tv_poll_secret_legacy_version != "" ? [1] : []
        content {
          name = "TV_POLL_SECRET_LEGACY"
          value_source {
            secret_key_ref {
              secret  = var.tv_poll_secret_id
              version = var.tv_poll_secret_legacy_version
            }
          }
        }
      }

      # PROVISION_AGENT_SECRET = TV プロビジョニング agent 認証 共有シークレット（Secret Manager 注入、ルール5）。
      # C方式: /api/tv/provisioning/* の agent 認証（PR4）。未設定なら agent route は fail-closed。
      dynamic "env" {
        for_each = var.provision_agent_secret_id != "" ? [1] : []
        content {
          name = "PROVISION_AGENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = var.provision_agent_secret_id
              version = "latest"
            }
          }
        }
      }

      # PARTNER_API_SECRET = portal ↔ v2 Partner API 共有シークレット（Secret Manager 注入、ルール5）。
      # K1 効果メトリクス pull /api/partner/*（partner-api-contract §1）。未設定なら partner route は fail-closed(401)。
      dynamic "env" {
        for_each = var.partner_api_secret_id != "" ? [1] : []
        content {
          name = "PARTNER_API_SECRET"
          value_source {
            secret_key_ref {
              secret  = var.partner_api_secret_id
              version = "latest"
            }
          }
        }
      }

      # APP_ENV = 実行環境名（非 secret・公開値）。staging 限定 dev-login の env ゲート（第1層）。
      # **prod では app_env="" のため注入しない** → prod の app は APP_ENV 不在 = isStagingEnv() false で
      # dev-login route が常に 404（多層防御。terraform 側で prod に "staging" を入れない不変条件）。
      dynamic "env" {
        for_each = var.app_env != "" ? [var.app_env] : []
        content {
          name  = "APP_ENV"
          value = env.value
        }
      }

      # DEV_LOGIN_CONFIG = staging 限定 dev-login のゲート鍵 + 任意の解決ヒント（password は持たない）の JSON
      # （Secret Manager 注入、ルール5）。dev-login の第2ゲート（Authorization: Bearer 突合）+ アカウント解決
      # （teacher.schoolId / admin.uid の任意ヒント）に使う。**prod では dev_login_secret_id="" のため注入しない**
      # → prod は config 不在で鍵検証もアカウント解決も不能（404）。
      dynamic "env" {
        for_each = var.dev_login_secret_id != "" ? [1] : []
        content {
          name = "DEV_LOGIN_CONFIG"
          value_source {
            secret_key_ref {
              secret  = var.dev_login_secret_id
              version = "latest"
            }
          }
        }
      }

      # GCP project ID。Vertex client は GCP_PROJECT_ID ?? GOOGLE_CLOUD_PROJECT、firebase-admin は
      # GOOGLE_CLOUD_PROJECT ?? GCLOUD_PROJECT を読む（fallback chain が別系統）。両系統を確実に満たすため
      # 3 変数すべてに project を設定する（いずれも公開値＝非 secret）。
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "GCLOUD_PROJECT"
        value = var.project_id
      }

      # Vertex AI location（app は VERTEX_LOCATION ?? "asia-northeast1"）。NFR07 データ越境ゼロ。
      env {
        name  = "VERTEX_LOCATION"
        value = var.vertex_location
      }

      # 実 Vertex 呼び出しの kill-switch（#289、ルール4 / ADR-030）。app は AI_ENABLED === "true" の時だけ
      # F03 抽出 / F06 Q&A チャット / F08 効果コメントの Vertex を通す。既定 false で AI OFF（fail-safe）。
      env {
        name  = "AI_ENABLED"
        value = tostring(var.ai_enabled)
      }

      # Editor AI の Gemini 2.5 思考トークン上限（#593 / #982）。空なら注入せず app は SDK 既定 dynamic。
      # "0" で思考を無効化し、構造化下書きの初回応答を最速化 + 出力トークン枯渇による無応答ハングを防ぐ。
      dynamic "env" {
        for_each = var.gemini_thinking_budget != "" ? [var.gemini_thinking_budget] : []
        content {
          name  = "GEMINI_THINKING_BUDGET"
          value = env.value
        }
      }

      # 広告メディア配信バケット（ADR-037）。空文字なら注入しない（受口は env 欠落で 502 = fail-close）。
      dynamic "env" {
        for_each = var.ad_media_bucket != "" ? [var.ad_media_bucket] : []
        content {
          name  = "AD_MEDIA_BUCKET"
          value = env.value
        }
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        # リクエスト処理中のみ CPU 割当（scale-to-zero でアイドル課金を避ける）。
        cpu_idle = true
      }

      # startup probe: 公開 liveness /api/health（middleware の matcher 除外・DB 非依存）。
      # Next standalone の cold start を待てるよう failure_threshold/period を緩めに取る。
      startup_probe {
        http_get {
          path = "/api/health"
          port = var.container_port
        }
        initial_delay_seconds = 10
        timeout_seconds       = 4
        period_seconds        = 10
        failure_threshold     = 6
      }
    }

    # Cloud SQL private IP への egress（内部 RFC1918 のみ connector 経由）。Vertex / Identity Platform 等の
    # Google API は既定 egress で到達するため Cloud NAT は不要。
    dynamic "vpc_access" {
      for_each = var.vpc_connector != "" ? [1] : []
      content {
        connector = var.vpc_connector
        egress    = "PRIVATE_RANGES_ONLY"
      }
    }
  }

  # enabled = true なのに image / DSN secret / connector が欠けると runtime で確実に失敗する → plan で fail-fast。
  lifecycle {
    # provider hashicorp/google 6.x が API から読み戻す **service レベル**の scaling ブロック
    # （google_cloud_run_v2_service.scaling = ServiceScaling: scaling_mode / manual_instance_count /
    # min_instance_count）を無視する。これは下の template.scaling（min/max を実際に管理する revision レベル
    # autoscaling）とは別物で、本サービスは service レベル scaling を一切設定しない。API は当該ブロックを
    # 既定値（manual_instance_count=0 / min_instance_count=0 / scaling_mode=null）で必ず materialize するが
    # config が省略するため、provider は毎回 `0 -> null` の in-place 除去を plan する（恒久 drift・実体は no-op）。
    # ignore_changes で当該ブロックのみ無視し、次の applier が無関係な drift を巻き込まないようにする
    # （管理対象の template.scaling は無視対象外なので min/max の管理はそのまま効く）。
    ignore_changes = [scaling]

    precondition {
      condition     = !var.enabled || var.image != ""
      error_message = "enabled = true のとき image は必須です（build/push 済の web イメージ、apps/web/Dockerfile）。"
    }
    precondition {
      condition     = !var.enabled || var.database_url_secret_id != ""
      error_message = "enabled = true のとき database_url_secret_id は必須です（DATABASE_URL を Secret Manager から注入、ルール5）。"
    }
    precondition {
      condition     = !var.enabled || var.vpc_connector != ""
      error_message = "enabled = true のとき vpc_connector は必須です（Cloud SQL private IP への egress、ルール2 のテナント分離 DB に接続）。"
    }
  }
}

# 公開アクセス（未認証 invoker）。app が自前で認証するため allUsers に roles/run.invoker を付与する。
# service への暗黙依存を作るため name は service リソースを参照する。
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count = var.enabled && var.allow_unauthenticated ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# カスタムドメインマッピング（var.custom_domain != "" のときのみ）。設計 = Cloud Run の
# カスタムドメインを直接マッピングし、外部から見える FQDN を 1 ドメイン配下に統合する
# （docs/discovery/wifi-filter-method.md §23-26 / 制約 C01・県教委 Wi-Fi の FQDN 許可リスト維持）。
#
# 前提: apex（school-signage.net）が Search Console で所有権検証済みであること（未検証だと apply が
# Google API エラーで失敗・他リソースは無傷）。apply 後 status.resource_records（CNAME → ghs.googlehosted.com）
# を output 経由で取得し Vercel DNS に登録 → マネージド TLS 証明書が自動発行される。
#
# 注: google_cloud_run_domain_mapping は Cloud Run（Knative）API のドメインマッピング。staging の単一
# サブドメイン公開には十分。本番 cutover では Cloud Armor 前提の Global External LB 経路へ昇格しうる
# （別途・人間ゲート）。
resource "google_cloud_run_domain_mapping" "web" {
  count = var.enabled && var.custom_domain != "" ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.custom_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.web[0].name
  }
}
