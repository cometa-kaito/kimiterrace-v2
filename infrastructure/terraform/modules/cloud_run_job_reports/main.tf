# Cloud Run Job + Cloud Scheduler 雛形（F09 月次レポート生成 / #430, #45）
#
# 対象: 月次レポート PDF 生成バッチ（apps/jobs/src/reports/report-job.ts → run.ts `runMonthlyReports`）。
# 全校横断ドライバが各校 1 PDF を生成し、Cloud Storage（report_storage モジュールのバケット）へ保存して
# `monthly_reports` に生成履歴を upsert する。これを Cloud Run Job として月初に定期実行する。
#
# 設計方針（CLAUDE.md ルール準拠）:
# - ルール2: DATABASE_URL は **kimiterrace_app ロール（非 BYPASSRLS）**。run.ts が校列挙を system_admin
#   context（listSchools）、各校の集計読取・履歴書込を school_admin 降格 context で行い RLS を効かせる。
#   Job 側は接続文字列を Secret Manager から注入するだけ。BYPASSRLS は使わない。
# - ルール5: secret は Secret Manager のみ。**JSON キーファイル禁止** — Job は専用 runtime SA として
#   Workload Identity で実行。DATABASE_URL は value_source.secret_key_ref で注入。GCS 認証は ADC
#   （Workload Identity）。REPORT_BUCKET はハードコードせず env で注入。
# - ルール8: すべて Terraform 管理。コンソール直接変更は緊急時のみ。
#
# === 設計判断: 汎用 cloud_run_job（embedding）の再利用でなく新規モジュール ===
# embedding 用 cloud_run_job は Vertex AI IAM（roles/aiplatform.user）と Vertex 系 env を**組み込みで**付与
# する。月次レポート Job は Vertex AI を一切使わない（PDF 生成 = pdfkit、集計 = SQL のみ）ため、再利用すると
# 不要な Vertex 権限が runtime SA に付き最小権限（ルール5）に反する。また REPORT_BUCKET / REPORT_YEAR /
# REPORT_MONTH という reports 固有 env が必要。よって embedding を**範に**新規モジュールを作る。
# egress 設計は embedding 準拠（PRIVATE_RANGES_ONLY、Cloud NAT 不要）: 本 Job は public な外部サイト
# （JMA 等）を叩かず、内部の Cloud SQL private IP への到達にだけ VPC connector が要る。PRIVATE_RANGES_ONLY
# では RFC1918 等の private 宛先だけが connector 経由で VPC に流れ、Cloud Storage の public endpoint
# （storage.googleapis.com）は connector を通らず Google 管理経路で直接出るため、NAT も Private Google Access も
# 不要で GCS に到達できる。よって external_egress_ready / NAT precondition は付けない（NAT が要るのは
# ALL_TRAFFIC で外部に出る weather Job だけ、ADR-021 単一 egress 経路）。
#
# === GCS 書込権限の所在 ===
# report_storage モジュールが**バケット限定**の writer IAM（roles/storage.objectAdmin）を `writer_service_account`
# 入力で受け付けるため、本モジュールは GCS IAM を持たず runtime SA の email を output するだけにする。env root
# でその output を report_storage.writer_service_account へ配線し、プロジェクト全体でなく当該バケットのみに
# objectAdmin（作成 + 冪等上書き = file.save、ルール5 最小権限）を限定付与する。
#
# 雛形段階は `enabled = false`（count = 0）で実体を生成しない（embedding / weather Job と同規律）。
# image / vpc_connector / database_url_secret_id / report_bucket 等は Phase 開発で値を詰めて enabled = true に切替。

locals {
  scheduler_job_name = "${var.job_name}-trigger"
}

# ── 実行用 SA（最小権限）─────────────────────────────────────────────
# Cloud SQL 接続 + DATABASE_URL secret 読取のみ。GCS 書込は report_storage が当該バケット限定で別途付与。
# Vertex AI 権限は持たない（PDF 生成 + 集計クエリだけ）。
resource "google_service_account" "job_runtime" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  account_id   = "${var.job_name}-sa"
  display_name = "F09 monthly-report runtime SA (${var.env})"
  description  = "Cloud Run Job (月次レポート生成) の実行 SA。Cloud SQL + DATABASE_URL secret に最小権限。GCS 書込はバケット限定で report_storage が付与。Vertex AI 権限なし。"
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

# ── Cloud Run Job ───────────────────────────────────────────────────
resource "google_cloud_run_v2_job" "reports" {
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

        # 起動コマンド = `node src/reports/report-job.js` 相当（ビルド済み JS）。
        command = var.container_command
        args    = var.container_args

        # PDF 保存先 Cloud Storage バケット名（report-job.ts 必須 env、ハードコード禁止・ルール5）。
        # env root で report_storage の bucket_name 出力を渡す。
        dynamic "env" {
          for_each = var.report_bucket != "" ? [1] : []
          content {
            name  = "REPORT_BUCKET"
            value = var.report_bucket
          }
        }
        # 対象年月（report-job.ts 必須 env、整数）。月初に前月分を生成する運用では、どの年月を生成するかは
        # 起動時に決まる（前月 = 実行時刻依存）。雛形段階は空既定で配線せず、enable-time に Scheduler の
        # http_target body などで動的注入する（固定値を焼くと毎回同じ月を再生成してしまう）。Phase 開発で確定。
        dynamic "env" {
          for_each = var.report_year != "" ? [1] : []
          content {
            name  = "REPORT_YEAR"
            value = var.report_year
          }
        }
        dynamic "env" {
          for_each = var.report_month != "" ? [1] : []
          content {
            name  = "REPORT_MONTH"
            value = var.report_month
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

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }
      }

      # Cloud SQL private IP への egress（network モジュールの VPC connector を渡す）。
      # egress = PRIVATE_RANGES_ONLY = private 宛先のみ connector 経由で VPC に流す。本 Job は public な
      # 外部 API を叩かないため、connector（network.vpc_connector_id）は Cloud SQL private IP 到達のために
      # 要るが Cloud NAT は不要。GCS の public endpoint（storage.googleapis.com）は connector を通らず
      # Google 管理経路で直接出るため NAT も Private Google Access も不要。外部 egress(NAT) が要るのは
      # ALL_TRAFFIC で出る weather Job だけ（cloud_run_job_weather, ADR-021 単一 egress 経路）。
      dynamic "vpc_access" {
        for_each = var.vpc_connector != "" ? [1] : []
        content {
          connector = var.vpc_connector
          egress    = "PRIVATE_RANGES_ONLY"
        }
      }
    }
  }

  # enabled = true なのに DB creds / egress / 保存先が未設定だと、plan は通るが runtime で確実に失敗する。
  # plan 時に fail-fast させて「DB に繋がらない / 保存先が無い Job」を本番に作らない（ルール2・5・8 の防御）。
  lifecycle {
    precondition {
      condition     = !var.enabled || var.database_url_secret_id != ""
      error_message = "enabled = true のとき database_url_secret_id は必須です（DATABASE_URL を Secret Manager から注入、ルール5）。"
    }
    precondition {
      condition     = !var.enabled || var.vpc_connector != ""
      error_message = "enabled = true のとき vpc_connector は必須です（Cloud SQL private IP への egress、ルール2 のテナント分離 DB に接続）。"
    }
    precondition {
      condition     = !var.enabled || var.report_bucket != ""
      error_message = "enabled = true のとき report_bucket は必須です（PDF 保存先、report_storage の bucket_name 出力を渡す、ルール5）。"
    }
  }
}

# ── Cloud Scheduler（Job を定期起動）────────────────────────────────
# 専用 SA（trigger 専用 = 最小権限）。Job 実行 API を OAuth トークンで叩く（静的鍵なし、ルール5）。
resource "google_service_account" "scheduler" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  account_id   = "${var.job_name}-sched"
  display_name = "F09 monthly-report scheduler SA (${var.env})"
  description  = "Cloud Scheduler が月次レポート生成 Job を起動するための SA（run.invoker のみ）。"
}

# scheduler SA に当該 Job の起動権限のみ付与（run.jobs.run を含む roles/run.invoker）。
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.reports[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "reports" {
  count = var.enabled ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = local.scheduler_job_name
  description      = "F09 月次レポート生成バッチの定期起動（月初、#430 / #45）"
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
