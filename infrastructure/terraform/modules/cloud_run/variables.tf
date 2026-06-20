# cloud_run モジュール入力
# ADR-002: Cloud Run (asia-northeast1) を採用
# ADR-008: Next.js Route Handlers 統合のため単一サービス

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP リージョン"
  type        = string
  default     = "asia-northeast1"
}

variable "env" {
  description = "環境名 (prod/staging/dev)"
  type        = string
}

variable "enabled" {
  description = "実体生成スイッチ。雛形段階は false（リソースを作らない）。"
  type        = bool
  default     = false
}

variable "service_name" {
  description = "Cloud Run service name"
  type        = string
  default     = "kimiterrace-web"
}

variable "image" {
  description = "Container image（例: asia-northeast1-docker.pkg.dev/<project>/kimiterrace/web:<tag>）。空なら enabled=true で fail-fast。"
  type        = string
  default     = ""
}

variable "database_url_secret_id" {
  description = <<-EOT
    DATABASE_URL を保持する Secret Manager secret の ID（ルール5）。
    値は **app login user**（テーブル非所有 → SET LOCAL ROLE kimiterrace_app で RLS 実効）の DSN。
    空文字なら env / accessor を配線しない（雛形）。
  EOT
  type        = string
  default     = ""
}

variable "tv_poll_secret_id" {
  description = <<-EOT
    TV_POLL_SECRET を保持する Secret Manager secret の ID（ルール5、F15/ADR-022）。
    TV ポーリング（/api/tv/config・/api/tv/lp-config）の共有シークレット。空文字なら env / accessor を
    配線しない（その場合 poll route は fail-closed で 401＝TV を接続させない）。
  EOT
  type        = string
  default     = ""
}

variable "tv_poll_secret_legacy_version" {
  description = <<-EOT
    ゼロダウンタイム鍵ローテーション用。TV_POLL_SECRET_LEGACY として配線する `tv_poll_secret_id` の
    **旧バージョン番号**（例 "3"）。移行期間中だけ旧キーも受理するために設定し、全 TV 端末を新キーへ
    更新し終えたら "" に戻して apply すれば旧キーは無効化される（poll-secret.ts は LEGACY 未配線時に
    現用キーのみ受理）。空文字なら TV_POLL_SECRET_LEGACY env を配線しない（＝単一キー運用・従来挙動）。
    accessor IAM は tv_poll_secret_id 全体に付与済みのため追加付与は不要。
  EOT
  type        = string
  default     = ""
}

variable "switchbot_webhook_secret_id" {
  description = <<-EOT
    SWITCHBOT_WEBHOOK_SECRET を保持する Secret Manager secret の ID（ルール5、F13/ADR-020）。
    人感センサ presence 受信 /api/sensors/switchbot/webhook の共有シークレット。値は cutover 設計上
    TV_POLL_SECRET（tv_poll_secret_id）と**同値**のため、prod は同じ secret を流用して配線する
    （docs/runbooks/prod-bringup-cutover.md「prod-tv-poll-secret = 旧 LP の SWITCHBOT_WEBHOOK_SECRET と同値」）。
    空文字なら env / accessor を配線しない（その場合 webhook route は fail-closed の 401＝presence を記録しない）。
    accessor IAM は tv_poll_secret_id と同一 secret を指す場合は既存付与で足りる（追加付与しない）。別 secret を
    指す時のみ本モジュールが accessor を追加する（重複バインディング回避）。
  EOT
  type        = string
  default     = ""
}

variable "provision_agent_secret_id" {
  description = <<-EOT
    PROVISION_AGENT_SECRET を保持する Secret Manager secret の ID（ルール5、C方式 TV プロビジョニング）。
    /api/tv/provisioning/* の agent 認証用 専用 共有シークレット（TV_POLL_SECRET とは別 secret）。
    tv_poll_secret_id と同じパターンで配線する。空文字なら env / accessor を配線しない
    （その場合 agent route は fail-closed＝未認証エージェントを到達させない）。
  EOT
  type        = string
  default     = ""
}

variable "partner_api_secret_id" {
  description = <<-EOT
    PARTNER_API_SECRET を保持する Secret Manager secret の ID（ルール5、partner-api-contract §1）。
    portal ↔ v2 サーバー間 Partner API（K1 効果メトリクス pull /api/partner/*）の共有シークレット。
    tv_poll_secret_id と同じパターンで配線する。空文字なら env / accessor を配線しない
    （その場合 partner route は fail-closed＝未認証の portal リクエストを到達させない）。
  EOT
  type        = string
  default     = ""
}

variable "vpc_connector" {
  description = <<-EOT
    Cloud SQL private IP 接続用の VPC connector（network モジュール出力 network.vpc_connector_id）。
    内部 egress（PRIVATE_RANGES_ONLY）のみ。Vertex / Identity Platform 等の Google API は既定 egress で
    到達するため Cloud NAT は不要。空文字なら VPC egress を付けない（雛形）。
  EOT
  type        = string
  default     = ""
}

variable "vertex_location" {
  description = "Vertex AI のロケーション（app の VERTEX_LOCATION env）。NFR07 データ越境ゼロ: asia-northeast1。"
  type        = string
  default     = "asia-northeast1"
}

variable "ai_enabled" {
  description = <<-EOT
    実 Vertex AI 呼び出しのアプリ側 kill-switch（#289、ルール4 / ADR-030）。app の env `AI_ENABLED` に写す。
    true の時だけ F03 抽出 / F06 Q&A チャット / F08 効果コメントが実 Vertex を呼ぶ。**既定 false**
    （fail-safe = AI OFF）。PII マスキング設計と aiplatform API 有効化の検証が済むまで AI を on にしない。
  EOT
  type        = bool
  default     = false
}

variable "gemini_thinking_budget" {
  description = <<-EOT
    Editor AI（会話アシスタント / 連絡ドラフト）の Gemini 2.5 思考（thinking）トークン上限を app の env
    `GEMINI_THINKING_BUDGET` に写す（#593 thinking-budget tuning）。**空文字なら env を注入しない**（app は未設定
    = SDK 既定 dynamic）。`"0"` で思考を**無効化**し、構造化下書きの初回応答を最速化 + maxOutputTokens(2048) を
    思考が食い潰して無応答になるハングを回避する（#982 本番「考えています」で固まる事故の緩和）。
  EOT
  type        = string
  default     = ""
}

variable "container_port" {
  description = "コンテナがリッスンするポート。apps/web/Dockerfile は 3000 をハードコード（Next standalone）。"
  type        = number
  default     = 3000
}

variable "min_instances" {
  description = "最小インスタンス数。0 = scale-to-zero（アイドル課金なし）。"
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "最大インスタンス数。"
  type        = number
  default     = 2
}

variable "cpu" {
  description = "コンテナ CPU リミット。"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "コンテナメモリリミット。Next.js SSR + AI SDK の余裕を見て env 側で調整可。"
  type        = string
  default     = "512Mi"
}

variable "allow_unauthenticated" {
  description = <<-EOT
    true で allUsers に roles/run.invoker を付与（未認証到達を許可）。app が自前で認証・認可するため
    既定 true。組織ポリシー（domain restricted sharing）で allUsers が禁止されている場合は false にし、
    別経路（IAP 等）を検討する。
  EOT
  type        = bool
  default     = true
}

variable "grant_vertex_user" {
  description = "true で runtime SA に roles/aiplatform.user を付与（Vertex AI Gemini 呼び出し、ルール4）。"
  type        = bool
  default     = true
}

variable "grant_identity_platform_admin" {
  description = <<-EOT
    true で runtime SA に roles/identitytoolkit.admin を付与。firebase-admin の verifyIdToken(checkRevoked)
    と F11 アカウント管理（create/update/revoke）が Identity Toolkit Admin API を叩くため、認証を使う限り必須。
  EOT
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Cloud Run service の削除保護。prod は true 推奨、staging/dev は recreate 容易性のため false（Issue #70）。"
  type        = bool
  default     = true
}

variable "custom_domain" {
  description = <<-EOT
    Cloud Run service にマッピングするカスタムドメイン FQDN（例 staging.school-signage.net）。
    空文字なら自動生成の <hash>.run.app のみ（マッピングを作らない）。

    **前提（apply 前に必須）**: 当該ドメインの apex（school-signage.net）が Google Search Console で
    **所有権検証済み**であること。未検証のまま apply するとドメインマッピング作成が Google API エラーで
    失敗する（インフラは壊れないが当該リソースのみ未作成）。検証は apex に対する 1 回限りで、サブドメインは
    検証済み apex の配下として継承される。DNS は Vercel（ns1/ns2.vercel-dns.com）管理。

    apply 後、`status.resource_records`（CNAME → ghs.googlehosted.com 等）を output から取得し Vercel DNS に
    登録 → マネージド TLS 証明書が自動発行される。

    設計: 県教委 Wi-Fi は FQDN(SNI) 許可リスト方式で `app.school-signage.net` を許可済（docs/discovery/
    wifi-filter-method.md, 制約 C01）。staging 用の別サブドメインは校内 Wi-Fi 許可リスト外（校外・合成データ
    での検証は可）。本番切替（cutover）では同一 FQDN `app.school-signage.net` を流用しフィルタ再申請ゼロ。
  EOT
  type        = string
  default     = ""
}

variable "ad_media_bucket" {
  description = <<-EOT
    広告メディア配信バケット名（env `AD_MEDIA_BUCKET`）。`/api/ads/media` 受口が広告クリエイティブを保存し、
    同一オリジン配信 Route `/ad-media/<key>` が GET する公開バケット（ADR-037 / modules/ad_media）。
    空文字なら env を注入せず、受口は fail-close（502）= 安全。書込み権限（objectAdmin）は env 側で当該バケット
    限定に付与する（ルール5 最小権限・ハードコード禁止）。
  EOT
  type        = string
  default     = ""
}
