// パッケージ公開エントリ。schema を再エクスポート。
export * from "./schema/index.js";
// RLS テナントコンテキスト ヘルパ (#48-B core: SET LOCAL primitive)
export * from "./client.js";
// クエリ層 (#48-F: 広告階層マージ)
export * from "./queries/effective-ads.js";
// F04: 即公開フロー + 安全網 (publish / update / unpublish / rollback ドメインサービス)
export * from "./queries/contents-publish.js";
// F05: クラス magic link (発行 / 失効 / 一覧 + 生徒匿名解決 resolve_magic_link)
export * from "./queries/magic-links.js";
// F04: content 読み取りクエリ層 (一覧 / 詳細 + バージョン履歴 + 公開状態、エディタ UI 用)
export * from "./queries/content-detail.js";
// F02: 教員音声 / チャット入力 (作成 / 一覧 / 詳細 / transcript 編集 / 下書き / submit / 削除 / 添付メタ)
export * from "./queries/teacher-inputs.js";
// #48-J: クラススコープ広告の読み取りクエリ層 (自クラス広告一覧 / 可視クラス確認 / 単件取得)
export * from "./queries/ads.js";
// #48-J-2: 学校設定 (school_configs) の読み取り / upsert クエリ層 (quiet_hours 等)
export * from "./queries/school-configs.js";
// #48-L (#123): システム管理者向け 学校 (テナント) マスタ一覧
export * from "./queries/schools.js";
// F12 (#48-M): フィードバック (匿名投稿 submit_feedback / system_admin 一覧)
export * from "./queries/feedback.js";
// F03 (#154): AI 構造化抽出結果の ai_extractions 永続化層 (RLS context 内 INSERT)
export * from "./queries/ai-extractions.js";
// F08 (#44): 効果ダッシュボードの行動ログ集計読み取り層 (view/tap totals + content ランキング)
export * from "./queries/event-stats.js";
// F09 (#45): 月次レポートの学校別サマリー集計読み取り層 (JST 暦月の totals/ranking/稼働日数)
export * from "./queries/monthly-report.js";
// F03 (#289): 職員氏名 roster (Vertex 送信前 PII マスキング供給用、ルール4)
export * from "./queries/users.js";
// F07/F09 (#322): 広告到達数 (advertiser reach) の minute-dedup 集計読み取り層 (ADR-025)
export * from "./queries/ad-reach.js";
// F03 (#348, ADR-027): 分散レート制限の Cloud SQL store (DistributedRateLimiter 用)
export * from "./queries/ai-rate-limit.js";
// F06 (#364, ADR-028): 生徒 Q&A の RAG 検索 (公開中 content_versions を pgvector で top-k、RLS 委譲)
export * from "./queries/rag-search.js";
// F13 (#408, ADR-020): SwitchBot Webhook の presence イベント書込み (cross-tenant 解決 + scoped insert)
export * from "./queries/sensor-presence.js";
