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
