# Architecture Decision Records (ADR)

技術判断の記録。**「なぜこれを選んだか」を後から読めるようにする**ためのもの。

## フォーマット

各 ADR は 1 ファイル、命名は `NNN-short-title.md`。

```markdown
# ADR-NNN: 短いタイトル

- 状態: Proposed / Accepted / Superseded by ADR-MMM / Deprecated
- 日付: YYYY-MM-DD
- 関連: #issue, ADR-XXX

## 文脈
何が課題で、どんな選択肢があったか。

## 決定
何を選んだか。1〜2文で明確に。

## 検討した代替案
- 代替A: なぜ却下したか
- 代替B: なぜ却下したか

## 結果（Consequences）
良い影響、悪い影響、トレードオフ。
```

## 索引

| ID | タイトル | 状態 |
|---|---|---|
| 001 | [Cloud SQL for PostgreSQL を採用、Firestore を捨てる](001-postgres-vs-firestore.md) | Accepted |
| 002 | [Cloud Run を採用、Cloud Functions を捨てる](002-cloud-run-vs-functions.md) | Accepted |
| 003 | [Identity Platform を採用、Firebase Auth は移行](003-identity-platform.md) | Accepted |
| 004 | [Drizzle ORM を採用、Prisma を却下](004-drizzle-vs-prisma.md) | Accepted |
| 005 | [Vertex AI Gemini を採用、データ越境回避](005-vertex-ai.md) | Accepted |
| 006 | [Vercel AI SDK でストリーミング UI](006-vercel-ai-sdk.md) | Accepted |
| 007 | [pgvector を採用、外部ベクトル DB 不採用](007-pgvector.md) | Accepted |
| 008 | [API は Next.js Route Handlers + Server Actions に統合、Hono 非採用](008-nextjs-route-handlers.md) | Accepted |
| 009 | [Terraform を採用、Pulumi を却下](009-terraform.md) | Accepted |
| 010 | [pnpm + Turborepo モノレポ](010-pnpm-turborepo.md) | Accepted |
| 011 | [Biome を採用、ESLint + Prettier 不採用](011-biome.md) | Accepted |
| 012 | [テストは Vitest + Playwright + 実 PostgreSQL](012-testing-stack.md)（Testcontainers 不採用、CI 側 service container + DATABASE_URL env で実走） | Accepted |
| 013 | [エラー追跡は Sentry](013-sentry.md) | Accepted |
| 014 | [観測は Cloud Logging + Cloud Trace + OTel](014-observability.md) | Accepted |
| 015 | [即公開 + 安全網 4 種](015-instant-publish-with-safety-nets.md)（承認フロー非採用） | Accepted |
| 016 | [クラス magic link 匿名アクセス](016-class-magic-link-anonymous-access.md)（個別アカウント非採用） | Accepted |
| 017 | [Gemini で AI 構造化 + confidence_score 必須化](017-gemini-ai-structuring-with-confidence.md) | Accepted |
| 018 | [CRM 機能の独自設計](018-custom-crm-design.md)（既存 SaaS 連携非採用） | Accepted |
| 019 | [RLS 二層分離](019-rls-two-layer-tenant-isolation.md)（school_id テナント + system_admin cross-tenant） | Accepted |
| 020 | [来場検知は SwitchBot Webhook + Cloud SQL](020-presence-sensor-switchbot-webhook.md)（自作 LiDAR 案を deprecate） | Accepted |
| 021 | [サイネージ天気予報は気象庁 (JMA) 無料 API + バックエンドキャッシュ](021-weather-data-source-jma.md)（端末は外部直叩きしない、商用 API 不採用） | Accepted |
| 022 | [TVリモート設定はポーリング方式](022-tv-remote-config-polling.md)（push 型 WebSocket/FCM 不採用） | Accepted |
| 023 | [TV死活・起動監視は last_seen ギャップ + 定期チェッカ + 多段アラート](023-tv-liveness-monitoring-alerting.md)（常時接続・外形監視 SaaS 不採用） | Accepted |
| 024 | [文書テキスト抽出と画像 OCR の外部委託境界](024-document-extraction-and-ocr-egress.md)（文書パーサはローカル自プロセス内、画像 OCR は Cloud Vision + 送信ガード必須） | Accepted |
| 025 | [広告 impression / 到達数の計上セマンティクス](025-impression-reach-counting-semantics.md)（延べ表示数=engagement と ソフト重複排除済 到達数=advertiser reach を分離、dedup は集計時 DISTINCT） | Accepted |
| 026 | [アカウント無効化 / ロール変更のエンフォース経路](026-account-deactivation-role-change-enforcement.md)（IdP を単一ソース: disable + revokeRefreshTokens / claims 再付与、既定 checkRevoked で即時失効。DB is_active は mirror、DB-only mutation を無効化と称さない） | Accepted |
| 027 | [F03 分散レート制限（Cloud SQL カウンタ行 vs Memorystore）](027-distributed-f03-rate-limit.md)（分散レート制限は Cloud SQL カウンタ行採用、Memorystore 不採用） | Accepted |
| 028 | [F06 生徒対話チャットボットの回答ポリシー](028-f06-chatbot-answer-policy.md)（対象=生徒+教員 / 掲示物 Q&A のみ・学習進路は拒否 / 根拠なし時はラベル付き一般補足だが学校固有事実は推測禁止 / 多言語対応 / コスト天井なし+rate limit） | Accepted |
| 029 | [公開エンドポイントの URL 内シークレット/トークンのロギング露出方針](029-url-secret-logging-exposure.md)（Cloud Run 自動 request log の URL secret 露出は補償統制下で情報ある受容＋本番はヘッダ優先推奨、ログ除外は NFR04 監査盲目化で不採用。#437 Low-2 / #439 を解決） | Accepted |
| 030 | [掲示物 authoring 時の生徒/保護者氏名（ロスター無し PII）検出ガード方針](030-authoring-time-pii-gate.md)（匿名設計で roster 源泉が無い生氏名は確定マスク/書式検出の対象外 → authoring 経路に決定論ヒューリスティック soft-gate（warn+override+監査）＋コンテンツポリシー強化。ML-NER は FP/コスト計測後の follow-up、hard-block は FP 阻害で不採用。#426） | Proposed |
| 031 | [MFA の段階的エンフォース戦略](031-mfa-phased-enforcement.md)（capability＝IdP mfa_config + enrollment フローを MVP で実装、PoC は任意、本番導入ゲートで teacher 以上に強制化して NFR03 充足。即全面強制＝PoC 導入摩擦/全面延期＝NFR03 未達 を不採用。#47） | Accepted |
| 032 | [教員ログインは学校共通パスワード方式](032-teacher-shared-password-login.md)（教員は per-school 共通 IdP アカウント + サーバ代理 signInWithPassword、個人帰属喪失は受容。個別アカウント運用負荷を不採用） | Accepted |
| 033 | [エディタ AI 連絡ドラフトは構造化リストのストリーミング + 項目ごと採否 UX](033-streaming-structured-ai-draft-ux.md)（`streamObject` array `elementStream`、可逆プレビュー・refine-in-place・PII/要確認をカード可視化・楽観+Undo。全件一括 apply / prose トークン流し / 自動挿入 を不採用。#243 ②） | Accepted |
| 034 | [公開サイネージ（教室端末）への個人名表示（来校者一覧・生徒呼び出し）の許容と境界](034-personal-names-on-classroom-signage.md)（教室端末という限定文脈で実名表示を許容、ADR-030 の roster 無し PII ゲートとは別境界として class スコープで管理。#804/#805） | Accepted |
| 035 | [鉄道運行情報（笠松駅・名鉄）の外部取得 — 公式ページのスクレイピングと端末閉域の維持](035-railway-operation-status-scraping.md)（取得 Job が公式運行情報ページをスクレイプ→バックエンドキャッシュ、端末は外部直叩きしない閉域維持。ADR-021 天気の先例踏襲） | Accepted |
| 036 | [エディタ AI「おまかせ」は 1 入力を予定/連絡/提出物へ分類し per-section 保存・採用前編集で担保](036-assistant-multi-section-classification.md)（1 入力を per-section 分類し採用前編集で精度担保。F02 教員入力、ADR-033 構造化ドラフト UX 上に構築） | Accepted |
| 037 | [サイネージ広告メディアの同一オリジン配信（`/ad-media/<key>` proxy）](037-ad-media-same-origin-serving.md)（公開バケットを `/ad-media/<key>` proxy で同一オリジン配信し県教委 Wi-Fi FQDN 許可リストと整合、端末の外部直接取得を不採用。#46/#48-F） | Accepted |
| 038 | [画像 OCR を Vertex Gemini マルチモーダル直送に切替（データレジデンシー優先）](038-image-ocr-gemini-multimodal-residency.md)（画像 OCR を Cloud Vision から Vertex Gemini マルチモーダル直送へ、NFR07 データ越境ゼロ優先。ADR-024 決定2 を supersede） | Accepted |
| 039 | [運営アカウントの portal↔v2 SSO は共通 IdP（Google Workspace）への federation](039-ops-sso-portal-v2-federation.md)（暫定=ディープリンク+ハンドオフ、ADR-003 を supersede せず拡張） | Accepted |

## ルール

- 既存 ADR は**書き換えない**。方針変更時は新 ADR を書き、旧 ADR を Superseded にする
- ドラフト段階は Proposed、レビュー後に Accepted
- 退役する技術は Deprecated
- 必ずトレードオフを書く。「良いこと」だけの ADR は信用されない
