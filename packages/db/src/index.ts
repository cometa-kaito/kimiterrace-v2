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
