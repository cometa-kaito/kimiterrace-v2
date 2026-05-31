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
