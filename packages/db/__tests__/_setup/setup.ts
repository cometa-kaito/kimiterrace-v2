// Per-test-file setup. グローバル `beforeEach` で context をリセットしたい場合に拡張する。
// 現状は何もしない (各テストファイルが個別に sql.begin() でトランザクションを切る)。
export {};
