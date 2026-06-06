# Cloud Run Job + Cloud Scheduler（F14 サイネージ天気取得 / #128, ADR-021）
#
# 対象: 気象庁(JMA)無料 JSON 予報 API から地域コード単位で予報を取得し、Cloud SQL の
# weather_forecasts テーブルにキャッシュするバッチ（apps/jobs/src/weather/weather-job.ts）。
# 全校横断ドライバ（run.ts `runWeatherFetchBatch`）を Cloud Run Job として定期実行する。
#
# 設計方針（CLAUDE.md ルール準拠 + ADR-021）:
# - ルール2: DATABASE_URL は **kimiterrace_app ロール（非 BYPASSRLS）**。weather_forecasts への
#   書込みは run.ts が system_admin context（weather_write_system policy）で行う。Job は接続文字列を
#   Secret Manager から注入するだけ。BYPASSRLS は使わない。
# - ルール5: secret は Secret Manager のみ。**JSON キーファイル禁止** — Job は専用 runtime SA として
#   Workload Identity で実行。DATABASE_URL / SENTRY_DSN は value_source.secret_key_ref で注入。
#   JMA は API キー不要（ADR-021）＝外部 API キー secret は存在しない。
# - ルール8: すべて Terraform 管理。コンソール直接変更は緊急時のみ。
# - 閉域原則（ADR-021 / [[closed-system-security]]）: 外部 egress を開けるのは **本 Job 経路だけ**。
#   サイネージ端末・Server Component は自社 DB から読むだけで、JMA を直接叩かない。egress は VPC connector
#   経由に集約し（egress_setting 既定 ALL_TRAFFIC）、外向きは Cloud NAT で出す（出口 1 経路で監査・FW 制御）。
#
# 雛形段階は `enabled = false`（count = 0）で実体を生成しない（embedding 用 cloud_run_job と同規律）。
# image / vpc_connector / database_url_secret_id 等は Phase 開発で値を詰めて enabled = true に切替。
#
# 【前提（enable-time）】外部 egress(JMA) には network モジュールの **Cloud NAT が必須**。
#   network モジュール（modules/network）の VPC connector + Cloud Router + Cloud NAT を先に enable し、
#   その出力を vpc_connector ← network.vpc_connector_id / external_egress_ready ← network.egress_ready で渡す。
#   ALL_TRAFFIC egress なのに NAT 不在だと runtime で外部 fetch がサイレント失敗するため、
#   下の lifecycle.precondition で plan 時に fail-fast させる（ADR-021 単一 egress 経路 / ADR-009）。

locals {
  scheduler_job_name = "${var.job_name}-trigger"
}

# ── 実行用 SA（最小権限）─────────────────────────────────────────────
# Cloud SQL 接続 + DATABASE_URL/SENTRY_DSN secret 読取のみ。Vertex AI 権限は持たない（JMA 取得だけ）。
resource "google_service_account" "job_runtime" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  account_id   = "${var.job_name}-sa"
  display_name = "F14 weather-fetch runtime SA (${var.env})"
  description  = "Cloud Run Job (天気取得) の実行 SA。Cloud SQL + DATABASE_URL/SENTRY_DSN secret に最小権限。Vertex AI 権限なし。"
}

# Cloud SQL 接続（ADR-001）。private IP + VPC egress で接続する前提。
resource "google_project_iam_member" "runtime_cloudsql_client" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.job_runtime[0].email}"
}

# DATABASE_URL secret の accessor（**該当 secret のみ** = 最小権限、ルール5）。
resource "google_secret_manager_secret_iam_member" "runtime_database_url" {
  count = var.enabled && var.database_url_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.database_url_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job_runtime[0].email}"
}

# SENTRY_DSN secret の accessor（ADR-013、該当 secret のみ = 最小権限、ルール5）。
resource "google_secret_manager_secret_iam_member" "runtime_sentry_dsn" {
  count = var.enabled && var.sentry_dsn_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.sentry_dsn_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job_runtime[0].email}"
}

# ── Cloud Run Job ───────────────────────────────────────────────────
resource "google_cloud_run_v2_job" "weather" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.job_name

  # 削除保護。prod は既定で保護（var 既定 true）、staging/dev は env 側で false に上書き可。
  deletion_protection = var.deletion_protection

  template {
    template {
      service_account = google_service_account.job_runtime[0].email
      max_retries     = var.max_retries
      timeout         = var.task_timeout

      containers {
        image = var.image

        # 起動コマンド = `node src/weather/weather-job.js` 相当（ビルド済み JS）。
        command = var.container_command
        args    = var.container_args

        # JMA への明示 User-Agent（ADR-021 §HTTP マナー、連絡先を含む）。
        env {
          name  = "WEATHER_FETCH_USER_AGENT"
          value = var.weather_fetch_user_agent
        }
        # JMA への HTTP タイムアウト（ms）。
        env {
          name  = "WEATHER_FETCH_TIMEOUT_MS"
          value = tostring(var.weather_fetch_timeout_ms)
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

      # egress（Cloud SQL private IP = 内部、JMA = 外部）を VPC connector 経由に集約する。
      # egress_setting 既定 ALL_TRAFFIC で外向きも VPC に通し Cloud NAT で出す（出口 1 経路、閉域原則）。
      dynamic "vpc_access" {
        for_each = var.vpc_connector != "" ? [1] : []
        content {
          connector = var.vpc_connector
          egress    = var.egress_setting
        }
      }
    }
  }

  # enabled = true なのに DB creds / egress が未設定だと、plan は通るが runtime で確実に失敗する。
  # plan 時に fail-fast させて「DB に繋がらない / JMA に出られない Job」を本番に作らない（ルール2・5・8 の防御）。
  lifecycle {
    precondition {
      condition     = !var.enabled || var.database_url_secret_id != ""
      error_message = "enabled = true のとき database_url_secret_id は必須です（DATABASE_URL を Secret Manager から注入、ルール5）。"
    }
    precondition {
      condition     = !var.enabled || var.vpc_connector != ""
      error_message = "enabled = true のとき vpc_connector は必須です（Cloud SQL private IP への接続 + JMA への外部 egress を VPC 経由に集約、ルール2 / ADR-021 閉域原則）。"
    }
    # vpc_connector があっても Cloud NAT（外部 egress 出口）が無ければ JMA に到達できない。
    # network モジュールの egress_ready（NAT 実在 signal）を external_egress_ready で受け取り、
    # ALL_TRAFFIC egress のとき NAT 必須を plan 時に強制する。これにより「connector はあるが NAT 不在で
    # 起動後サイレントに外部 fetch 失敗する Job」を本番に作らない（ADR-021 単一 egress 経路 / ADR-009）。
    precondition {
      condition     = !var.enabled || var.egress_setting != "ALL_TRAFFIC" || var.external_egress_ready
      error_message = "enabled = true かつ egress_setting = ALL_TRAFFIC（外部 egress）のとき external_egress_ready = true が必須です。network モジュールの Cloud NAT を先に enable し、その egress_ready 出力を渡してください（NAT 無しでは JMA に到達不可、ADR-021 / ADR-009）。"
    }
  }
}

# ── Cloud Scheduler（Job を定期起動）────────────────────────────────
# 専用 SA（trigger 専用 = 最小権限）。Job 実行 API を OAuth トークンで叩く（静的鍵なし、ルール5）。
resource "google_service_account" "scheduler" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  # SA account_id は 6〜30 文字制限。既定 job_name "kimiterrace-weather-fetch"(25) + "-sched"(6) = 31 で
  # 超過するため接尾辞を "-sch"(4 → 計29) に縮める（runtime SA は "-sa" で 28、こちらは制限内）。
  account_id   = "${var.job_name}-sch"
  display_name = "F14 weather-fetch scheduler SA (${var.env})"
  description  = "Cloud Scheduler が天気取得 Job を起動するための SA（run.invoker のみ）。"
}

# scheduler SA に当該 Job の起動権限のみ付与（run.jobs.run を含む roles/run.invoker）。
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.weather[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "weather" {
  count = var.enabled ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = local.scheduler_job_name
  description      = "F14 天気取得バッチの定期起動（#128, ADR-021）"
  schedule         = var.schedule
  time_zone        = var.schedule_time_zone
  attempt_deadline = "320s"

  retry_config {
    retry_count = var.scheduler_retry_count
  }

  http_target {
    http_method = "POST"
    # Cloud Run Admin API v2 の jobs:run エンドポイント。
    uri = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${var.job_name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler[0].email
    }
  }
}
