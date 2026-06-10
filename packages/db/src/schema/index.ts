// 全テーブルの公開エクスポート。drizzle-kit はこのファイルから schema を辿る。
// enum も明示 re-export しないと drizzle-kit がスナップショットに enum を登録できず、
// generate のたびに既存 enum の DROP TYPE を吐く (Issue #101 / PR #104 の真因)。
export * from "../_shared/enums.js";
export * from "./schools.js";
export * from "./users.js";
export * from "./classes.js";
export * from "./memberships.js";
export * from "./magic-links.js";
export * from "./contents.js";
export * from "./content-versions.js";
export * from "./publishes.js";
export * from "./events.js";
// F13 (#391, ADR-020): 来場検知センサーのデバイス登録（presence events は events テーブルへ）
export * from "./sensor-devices.js";
// F15/F16 (ADR-022/ADR-023): TV デバイスのリモート設定レジストリ + ポーリング心拍（last_seen 死活）
export * from "./tv-devices.js";
// パターン2 サイネージ「来校者一覧」: クラス×日別の来校者レコード（RLS テナント分離 + 監査）
export * from "./class-visitors.js";
// パターン2 サイネージ「生徒呼び出し」: クラス×日別の呼び出しレコード（実名表示・ADR-034・RLS + 監査）
export * from "./student-callouts.js";
// F16 (ADR-023): TV ダウンタイム（無応答インシデント）記録。定期チェッカが down/recover 遷移で書く
export * from "./tv-device-downtime.js";
// F15 (ADR-022): TV リモートコマンドキュー（enqueue + ポーリング配信 + ack、send-once）
export * from "./tv-device-commands.js";
// C方式 TV プロビジョニング: クラウド UI で作成し現地ローカルエージェントが claim/実行するジョブ（段階WF）
export * from "./tv-provisioning-jobs.js";
// F14 (#128, ADR-021): サイネージ天気予報の地域単位キャッシュ（school_id 非保持の公開参照テーブル）
export * from "./weather-forecasts.js";
export * from "./ai-extractions.js";
export * from "./ai-chat-sessions.js";
export * from "./ai-chat-messages.js";
// F03 (#347, ADR-027): Cloud SQL カウンタ行で実装する分散レート制限のウィンドウテーブル
export * from "./ai-rate-limit-windows.js";
// F02: 教員音声 / チャット入力 + 添付メタ
export * from "./teacher-inputs.js";
export * from "./teacher-input-attachments.js";
// Part C1: CRM + cross-tenant
export * from "./advertisers.js";
export * from "./contracts.js";
// F10 (#46): 契約 ⇄ 出稿コンテンツの紐付け (cross-tenant CRM 中間表、system_admin_only RLS)
export * from "./contract-contents.js";
export * from "./communications.js";
export * from "./monthly-reports.js";
export * from "./system-admins.js";
// F12 (#48-M): フィードバック (cross-tenant / system_admin_only、非認証投稿)
export * from "./feedback.js";
export * from "./audit-log.js";
// F0 (#48-A): V1 移植 — 階層基盤テーブル
export * from "./grades.js";
export * from "./departments.js";
export * from "./school-configs.js";
export * from "./daily-data.js";
export * from "./ads.js";
// F0 (#48-F): 広告階層マージ VIEW (実体は migrations/0007、ここは型定義のみ)
export * from "./effective-ads-view.js";
