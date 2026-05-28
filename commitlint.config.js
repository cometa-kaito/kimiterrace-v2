/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat", // 新機能
        "fix", // バグ修正
        "docs", // ドキュメント
        "style", // フォーマット (機能影響なし)
        "refactor", // リファクタ
        "perf", // パフォーマンス改善
        "test", // テスト追加・修正
        "build", // ビルド・依存関係
        "ci", // CI 設定
        "chore", // その他雑務
        "revert", // 取り消し
        "security", // セキュリティ修正
        "infra", // インフラ (Terraform 等)
        "db", // DB スキーマ・マイグレーション
      ],
    ],
    "subject-case": [0],
    "subject-max-length": [2, "always", 100],
    "header-max-length": [2, "always", 120],
    "body-max-line-length": [2, "always", 200],
    "footer-max-line-length": [2, "always", 200],
  },
};
