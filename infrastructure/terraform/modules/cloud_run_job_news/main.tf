# Cloud Run Job + Cloud Scheduler（pattern2/3 サイネージ工学ニュース取得 / ADR-043）
#
# 対象: 政府系 / JST の公開 RSS（JST サイエンスポータル / 文部科学省 index.rdf 等）を取得・パースし、
# Cloud SQL の news_items テーブルに **見出し + 出典 URL + 公開日のみ**（本文非転載・ADR-043 著作権方針）を
# キャッシュするバッチ（apps/jobs/src/news/news-job.ts）。Cloud Run Job として定期実行する
# （weather Job = ADR-021 / railway Job = ADR-035 と同型）。
#
# 設計方針（CLAUDE.md ルール準拠 + ADR-043）:
# - ルール2: DATABASE_URL は **kimiterrace_app ロール（非 BYPASSRLS）**。news_items への書込みは
#   run.ts が system_admin context（news_items_write_system policy）で行う。BYPASSRLS は使わない。
# - ルール5: secret は Secret Manager のみ（JSON キー禁止）。Job は専用 runtime SA で Workload Identity 実行。
#   RSS 取得は API キー不要 ＝ 外部 API キー secret は存在しない（キーレス）。
# - ルール8: すべて Terraform 管理。
# - 閉域原則（ADR-043 / [[closed-system-security]]）: 外部 egress を開けるのは **本 Job 経路だけ**。
#   サイネージ端末・Server Component は自社 DB（news_items）から読むだけで RSS を直接叩かない。egress は
#   VPC connector 経由に集約し（egress_setting 既定 ALL_TRAFFIC）、外向きは Cloud NAT で出す（出口 1 経路）。
#
# 雛形段階は `enabled = false`（count = 0）。image / vpc_connector / database_url_secret_id を詰めて
# enabled = true に切替（weather / railway Job と同規律）。enable-time は network モジュールの Cloud NAT が
# 必須（external_egress_ready で fail-fast、ADR-043 / ADR-009 単一 egress）。

locals {
  scheduler_job_name = "${var.job_name}-trigger"
}

# ── 実行用 SA（最小権限）─────────────────────────────────────────────
resource "google_service_account" "job_runtime" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  account_id   = "${var.job_name}-sa"
  display_name = "news-fetch runtime SA (${var.env})"
  description  = "Cloud Run Job (工学ニュース取得) の実行 SA。Cloud SQL + DATABASE_URL/SENTRY_DSN secret に最小権限。Vertex AI 権限なし。"
}

resource "google_project_iam_member" "runtime_cloudsql_client" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.job_runtime[0].email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_database_url" {
  count = var.enabled && var.database_url_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.database_url_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job_runtime[0].email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_sentry_dsn" {
  count = var.enabled && var.sentry_dsn_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.sentry_dsn_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job_runtime[0].email}"
}

# ── Cloud Run Job ───────────────────────────────────────────────────
resource "google_cloud_run_v2_job" "news" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.job_name

  deletion_protection = var.deletion_protection

  template {
    template {
      service_account = google_service_account.job_runtime[0].email
      max_retries     = var.max_retries
      timeout         = var.task_timeout

      containers {
        image = var.image

        # 起動コマンド = `node dist/news/news-job.js` 相当（ビルド済み JS）。
        command = var.container_command
        args    = var.container_args

        # 各機関 RSS への明示 User-Agent（連絡先を含む、ADR-043 §礼儀）。
        env {
          name  = "NEWS_FETCH_USER_AGENT"
          value = var.news_fetch_user_agent
        }
        # 各機関 RSS への HTTP タイムアウト（ms）。
        env {
          name  = "NEWS_FETCH_TIMEOUT_MS"
          value = tostring(var.news_fetch_timeout_ms)
        }
        # フィード定義の上書き（任意・公開 RSS URL ＝ 非秘匿）。空なら未設定でコード既定にフォールバック。
        # meti（経産省）等の追加・URL 変化に env で追従する（ADR-043 §決定 / 残存リスク②）。
        dynamic "env" {
          for_each = var.news_feeds_json != "" ? [1] : []
          content {
            name  = "NEWS_FEEDS_JSON"
            value = var.news_feeds_json
          }
        }
        # DATABASE_URL は **Secret Manager から注入**（ルール5、ハードコード禁止）。
        # 値は kimiterrace_app ロール（非 BYPASSRLS）の DSN（ルール2）。
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
        # SENTRY_DSN も Secret Manager から注入（ADR-013、ルール5）。未設定なら Sentry 送信は無効。
        dynamic "env" {
          for_each = var.sentry_dsn_secret_id != "" ? [1] : []
          content {
            name = "SENTRY_DSN"
            value_source {
              secret_key_ref {
                secret  = var.sentry_dsn_secret_id
                version = "latest"
              }
            }
          }
        }

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }
      }

      # egress（Cloud SQL private IP = 内部、各機関 RSS = 外部）を VPC connector 経由に集約し Cloud NAT で出す。
      dynamic "vpc_access" {
        for_each = var.vpc_connector != "" ? [1] : []
        content {
          connector = var.vpc_connector
          egress    = var.egress_setting
        }
      }
    }
  }

  # enable-time に DB creds / egress が未設定だと runtime で確実に失敗するため plan 時に fail-fast（weather / railway と同型）。
  lifecycle {
    precondition {
      condition     = !var.enabled || var.database_url_secret_id != ""
      error_message = "enabled = true のとき database_url_secret_id は必須です（DATABASE_URL を Secret Manager から注入、ルール5）。"
    }
    precondition {
      condition     = !var.enabled || var.vpc_connector != ""
      error_message = "enabled = true のとき vpc_connector は必須です（Cloud SQL private IP 接続 + 各機関 RSS への外部 egress を VPC 経由に集約、ルール2 / ADR-043 閉域原則）。"
    }
    precondition {
      condition     = !var.enabled || var.egress_setting != "ALL_TRAFFIC" || var.external_egress_ready
      error_message = "enabled = true かつ egress_setting = ALL_TRAFFIC（外部 egress）のとき external_egress_ready = true が必須です。network モジュールの Cloud NAT を先に enable し egress_ready 出力を渡してください（NAT 無しでは各機関 RSS に到達不可、ADR-043 / ADR-009）。"
    }
  }
}

# ── Cloud Scheduler（Job を定期起動）────────────────────────────────
resource "google_service_account" "scheduler" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  # SA account_id は 6〜30 文字制限。job_name "kimiterrace-news-fetch"(22) + "-sch"(4) = 26 で制限内。
  account_id   = "${var.job_name}-sch"
  display_name = "news-fetch scheduler SA (${var.env})"
  description  = "Cloud Scheduler が工学ニュース取得 Job を起動するための SA（run.invoker のみ）。"
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.news[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "news" {
  count = var.enabled ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = local.scheduler_job_name
  description      = "pattern2/3 サイネージ工学ニュース取得バッチの定期起動（ADR-043）"
  schedule         = var.schedule
  time_zone        = var.schedule_time_zone
  attempt_deadline = "320s"

  retry_config {
    retry_count = var.scheduler_retry_count
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${var.job_name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler[0].email
    }
  }
}
