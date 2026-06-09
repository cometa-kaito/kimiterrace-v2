# Cloud Run Job + Cloud Scheduler（F16 TV 死活監視 / #94, ADR-023, ADR-014）
#
# 対象: tv_devices の last_seen_at を全校横断で走査し、閾値超過を down / 復帰を recover として反映しつつ、
# 遷移を Slack に配信するバッチ（apps/jobs/src/tv-liveness/{tv-liveness-job.ts,run.ts}）。Cloud Scheduler から
# **毎分**（"* * * * *"）24/7 起動する dead man's switch 込みの tight monitoring（PR7 / F16 §9, ADR-023）。
#
# 設計方針（CLAUDE.md ルール準拠 + ADR-023）:
# - ルール2: DATABASE_URL は **kimiterrace_app ロール（非 BYPASSRLS）**。down/recover の反映は run.ts が
#   system_admin context（system_admin_full_access policy）で行う。Job は接続文字列を Secret Manager から
#   注入するだけ。BYPASSRLS は使わない。
# - ルール5: secret は Secret Manager のみ。**JSON キーファイル禁止** — Job は専用 runtime SA として
#   Workload Identity で実行。DATABASE_URL / SENTRY_DSN / SLACK_WEBHOOK_URL は value_source.secret_key_ref で注入。
# - ルール8: すべて Terraform 管理。コンソール直接変更は緊急時のみ。
# - 閉域原則（ADR-021 / [[closed-system-security]]）: 外部 egress を開けるのは **本 Job 経路（Slack 通知）だけ**。
#   weather Job（JMA POST）と同じく egress は VPC connector 経由に集約し（egress_setting 既定 ALL_TRAFFIC）、
#   外向きは Cloud NAT で出す（出口 1 経路で監査・FW 制御）。Slack（incoming webhook）が外部依存先。
#
# 雛形段階は `enabled = false`（count = 0）で実体を生成しない（weather Job と同規律）。
# image / vpc_connector / database_url_secret_id 等は Phase 開発で値を詰めて enabled = true に切替。
#
# 【前提（enable-time）】外部 egress(Slack) には network モジュールの **Cloud NAT が必須**。
#   network モジュール（modules/network）の VPC connector + Cloud Router + Cloud NAT を先に enable し、
#   その出力を vpc_connector ← network.vpc_connector_id / external_egress_ready ← network.egress_ready で渡す。
#   ALL_TRAFFIC egress なのに NAT 不在だと runtime で Slack POST がサイレント失敗するため、
#   下の lifecycle.precondition で plan 時に fail-fast させる（ADR-021 単一 egress 経路 / ADR-009）。

locals {
  scheduler_job_name = "${var.job_name}-trigger"
}

# ── 実行用 SA（最小権限）─────────────────────────────────────────────
# Cloud SQL 接続 + DATABASE_URL/SENTRY_DSN/SLACK_WEBHOOK_URL secret 読取のみ。Vertex AI 権限は持たない。
resource "google_service_account" "job_runtime" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  account_id   = "${var.job_name}-sa"
  display_name = "F16 tv-liveness runtime SA (${var.env})"
  description  = "Cloud Run Job (TV 死活) の実行 SA。Cloud SQL + DATABASE_URL/SENTRY_DSN/SLACK_WEBHOOK_URL secret に最小権限。Vertex AI 権限なし。"
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

# SLACK_WEBHOOK_URL secret の accessor（PR7 / F16 §9、該当 secret のみ = 最小権限、ルール5）。
# 空文字なら配線しない（Slack 送信は no-op）。SENTRY_DSN と同じ optional パターン。
resource "google_secret_manager_secret_iam_member" "runtime_slack_webhook_url" {
  count = var.enabled && var.slack_webhook_url_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.slack_webhook_url_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job_runtime[0].email}"
}

# ── Cloud Run Job ───────────────────────────────────────────────────
resource "google_cloud_run_v2_job" "tv_liveness" {
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

        # 起動コマンド = `node dist/tv-liveness/tv-liveness-job.js` 相当（ビルド済み JS）。weather と同じ
        # jobs イメージを共有し command/args だけ差し替える（WORKDIR=/app/apps/jobs）。
        command = var.container_command
        args    = var.container_args

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
        # SLACK_WEBHOOK_URL も Secret Manager から注入（PR7 / F16 §9、ルール5）。未設定なら Slack 送信は
        # no-op（PR7 のコードが空をハンドル）。SENTRY_DSN と同じ optional 注入パターン。
        dynamic "env" {
          for_each = var.slack_webhook_url_secret_id != "" ? [1] : []
          content {
            name = "SLACK_WEBHOOK_URL"
            value_source {
              secret_key_ref {
                secret  = var.slack_webhook_url_secret_id
                version = "latest"
              }
            }
          }
        }
        # 閾値 override（任意）。空文字なら env を設定せず Job entrypoint の既定 120/120（F16 §9 24/7 tight）が効く。
        # secret ではない平文の運用パラメータゆえ value で直接渡す。
        dynamic "env" {
          for_each = var.tv_down_threshold_sec != "" ? [1] : []
          content {
            name  = "TV_DOWN_THRESHOLD_SEC"
            value = var.tv_down_threshold_sec
          }
        }
        dynamic "env" {
          for_each = var.tv_off_hours_threshold_sec != "" ? [1] : []
          content {
            name  = "TV_OFF_HOURS_THRESHOLD_SEC"
            value = var.tv_off_hours_threshold_sec
          }
        }
        # dead man's switch（チェッカ自身の死活、ADR-014）用の任意 heartbeat。空文字なら設定しない。
        dynamic "env" {
          for_each = var.tv_liveness_heartbeat != "" ? [1] : []
          content {
            name  = "TV_LIVENESS_HEARTBEAT"
            value = var.tv_liveness_heartbeat
          }
        }

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }
      }

      # egress（Cloud SQL private IP = 内部、Slack = 外部）を VPC connector 経由に集約する。
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
  # plan 時に fail-fast させて「DB に繋がらない / Slack に出られない Job」を本番に作らない（ルール2・5・8 の防御）。
  lifecycle {
    precondition {
      condition     = !var.enabled || var.database_url_secret_id != ""
      error_message = "enabled = true のとき database_url_secret_id は必須です（DATABASE_URL を Secret Manager から注入、ルール5）。"
    }
    precondition {
      condition     = !var.enabled || var.vpc_connector != ""
      error_message = "enabled = true のとき vpc_connector は必須です（Cloud SQL private IP への接続 + Slack への外部 egress を VPC 経由に集約、ルール2 / ADR-021 閉域原則）。"
    }
    # vpc_connector があっても Cloud NAT（外部 egress 出口）が無ければ Slack に到達できない。
    # network モジュールの egress_ready（NAT 実在 signal）を external_egress_ready で受け取り、
    # ALL_TRAFFIC egress のとき NAT 必須を plan 時に強制する。これにより「connector はあるが NAT 不在で
    # 起動後サイレントに Slack POST 失敗する Job」を本番に作らない（ADR-021 単一 egress 経路 / ADR-009）。
    precondition {
      condition     = !var.enabled || var.egress_setting != "ALL_TRAFFIC" || var.external_egress_ready
      error_message = "enabled = true かつ egress_setting = ALL_TRAFFIC（外部 egress）のとき external_egress_ready = true が必須です。network モジュールの Cloud NAT を先に enable し、その egress_ready 出力を渡してください（NAT 無しでは Slack に到達不可、ADR-021 / ADR-009）。"
    }
  }
}

# ── Cloud Scheduler（Job を定期起動）────────────────────────────────
# 専用 SA（trigger 専用 = 最小権限）。Job 実行 API を OAuth トークンで叩く（静的鍵なし、ルール5）。
resource "google_service_account" "scheduler" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  # SA account_id は 6〜30 文字制限。job_name "kimiterrace-tv-liveness"(23) + "-sch"(4) = 27 で制限内
  # （weather と同じ "-sch" 接尾辞規律。runtime SA は "-sa" で 26）。
  account_id   = "${var.job_name}-sch"
  display_name = "F16 tv-liveness scheduler SA (${var.env})"
  description  = "Cloud Scheduler が TV 死活 Job を起動するための SA（run.invoker のみ）。"
}

# scheduler SA に当該 Job の起動権限のみ付与（run.jobs.run を含む roles/run.invoker）。
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.tv_liveness[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "tv_liveness" {
  count = var.enabled ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = local.scheduler_job_name
  description      = "F16 TV 死活チェックの毎分起動（24/7、#94, ADR-023）"
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
