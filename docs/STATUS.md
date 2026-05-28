# プロジェクト現在地

> このファイルは Claude Code セッションの起点。新セッションは必ずこれを読む。
> セッション終了時に必ず更新する。

最終更新: 2026-05-28 (W0 人間タスク大半完了)
更新者: Claude Code

リポジトリ: https://github.com/cometa-kaito/kimiterrace-v2 (public)
Issue 一覧: https://github.com/cometa-kaito/kimiterrace-v2/issues
GCP プロジェクト: signage-v2-prod (asia-northeast1, 課金有効)

---

## 現在のフェーズ

**W0: 準備フェーズ（リポジトリ初期化・要件・設計ドラフト）**

- プロジェクト方針確定: [memory: GCP 全改修方針](../../.claude/projects/.../memory/project_kimiterrace_stack.md)
- 12週計画: [ROADMAP.md](ROADMAP.md)
- 規律: [CLAUDE.md](../CLAUDE.md)

---

## 直近の完了

- 2026-05-28: 移行方針確定（GCP ネイティブへ全改修、12週計画）
- 2026-05-28: kimiterrace-v2 リポジトリ初期化 + GitHub 公開
- 2026-05-28: CLAUDE.md 作成（8つの開発規律）
- 2026-05-28: docs/ 構造作成（STATUS, ROADMAP, adr, requirements, architecture, compliance, runbooks）
- 2026-05-28: pnpm + Turborepo + Biome + TypeScript strict 設定
- 2026-05-28: husky + lint-staged + commitlint (Conventional Commits)
- 2026-05-28: CI ワークフロー（lint, typecheck, test, build, security scan）
- 2026-05-28: branch protection 設定（CI 必須・linear history・force push 禁止）
- 2026-05-28: W0 Issue 作成完了 (#11〜#22)
- 2026-05-28: **人間タスク完了** — gcloud SDK / Terraform インストール、GCP プロジェクト作成、課金紐付け、Sentry アカウント、Wi-Fi 方式確認（ドメインベースで OK）
- 2026-05-28: 必須 GCP API 有効化（Cloud Run / Cloud SQL / Identity Platform / Vertex AI / Secret Manager / VPC など）

---

## 今やっているもの

| 担当 | Issue | タスク | 進捗 |
|---|---|---|---|
| Claude | #11 | 既存システム棚卸し | 未着手 |
| Claude | #12 | 機能要件 F01-F07 ドラフト | 未着手 |
| Claude | #13 | 非機能要件 NFR01-NFR06 ドラフト | 未着手 |
| Claude | #14 | ADR 001-014 初稿 | 未着手 |
| Claude | #15 | PostgreSQL スキーマ DDL 初稿 | 未着手 |
| Claude | #16 | C4 図 + シーケンス図 | 未着手 |
| Claude | #17 | 脅威モデル STRIDE | 未着手 |
| Claude | #18 | ローカル開発環境 docker-compose | 未着手 |
| 人間 | #19 | gcloud SDK / Terraform インストール | ✅ 完了 |
| 人間 | #20 | GCP プロジェクト `signage-v2-prod` 作成 | ✅ 完了 |
| 人間 | #21 | 県教委 Wi-Fi フィルタ方式問合せ | ✅ 完了（ドメインベース） |
| 人間 | #22 | ペネトレ業者3社見積依頼 | ❌ **実施しない判断（要再検討）** |

---

## 次にやるべき（優先順）

1. リポジトリ基盤完了（pnpm workspace, CI, hooks, branch protection）
2. 既存システム棚卸し（Firestore コレクション・Functions・UI ルート）
3. 機能要件 F01-F07 のドラフト
4. 非機能要件 NFR01-NFR06 のドラフト
5. ADR 001-014 の初稿（スタック確定の根拠）
6. PostgreSQL スキーマ DDL 初稿
7. C4 Container 図（Mermaid）
8. 脅威モデル（STRIDE）ドラフト
9. Terraform 雛形（modules + dev environment）
10. ローカル開発環境（docker-compose で postgres + pgvector）

---

## 詰まり / 確認待ち

- なし（外部要因の詰まりは解消）

## 重要な未決定事項

- **第三者セキュリティ診断（ペネトレ）の代替策**:
  ユーザー判断で従来型ペネトレは実施しない。
  公立校データを扱う SaaS としては**第三者検証ゼロは推奨できない**。
  代替案（SaaS 型診断、簡易診断、内部チェックリスト、バグバウンティ）を検討する必要あり。
  詳細議論は次セッション。

---

## 重要な近況の判断

- **2026-05-28**: Firebase 継続方針を反転、GCP ネイティブ全改修へ → 後日 ADR-000 として記録
- **2026-05-28**: API 層は Next.js Route Handlers に統合（Hono 非採用） → ADR-008 ドラフト要
- **2026-05-28**: API 層に tRPC は使わず、`zod` + REST に統一する暫定方針 → 要 ADR

---

## 既知のリスク

| リスク | 影響度 | 対応 |
|---|---|---|
| 県 Wi-Fi が IP ベースフィルタの場合、Cloud Run 移行で疎通不可 | 高 | 確認待ち。最悪は Firebase Hosting の前段に Cloud Run を置く構成も可 |
| ペネトレテスト見積が予算超過の可能性 | 中 | 3社相見積もり、SaaS型の脆弱性診断（年契約）も検討 |
| 移行中の既存運用学校（岐南工業）への影響 | 中 | 並行運用期間を 2 週間確保、DNS は最後に切替 |
| 12週計画の遅延 | 中 | 週次振り返りで早期検知、機能スコープを縮める判断を週次レビューで |

---

## セッション履歴

> 各セッションでこの欄に追記する。形式: `YYYY-MM-DD: 何をやったか / 何を残したか`

- **2026-05-28**: プロジェクト初期化、CLAUDE.md・STATUS.md・ROADMAP.md 作成完了、Issue 化はこれから
- **2026-05-28**: 全基盤セットアップ完了。リポジトリ公開、CI/branch protection 設定、W0 Issue #11-#22 登録。次セッションは #11 から着手予定
- **2026-05-28**: 人間タスク (#19-#21) 完了確認、GCP API 有効化、Wi-Fi/GCP/dev-tools の状態を docs/discovery/ に記録。ペネトレ (#22) は不実施判断が出たが要再検討
