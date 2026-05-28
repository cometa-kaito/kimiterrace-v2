# プロジェクト現在地

> このファイルは Claude Code セッションの起点。新セッションは必ずこれを読む。
> セッション終了時に必ず更新する。

最終更新: 2026-05-28 (v2-mvp.md ドラフト起草完了、ユーザーレビュー待ち)
更新者: Claude Code

リポジトリ: https://github.com/cometa-kaito/kimiterrace-v2 (public)
Issue 一覧: https://github.com/cometa-kaito/kimiterrace-v2/issues
GCP プロジェクト: signage-v2-prod (asia-northeast1, 課金有効)

---

## 現在のフェーズ

**Phase 調査 → Phase 設計 (移行中)**

ロードマップは 4 Phase 構成（調査・設計・開発・導入）に再設計済 (2026-05-28)。
**Claude は調査〜開発を全力で進める。導入は人間担当**。

- プロジェクト方針: [memory: GCP 全改修方針](../../.claude/projects/.../memory/project_kimiterrace_stack.md)
- ビジネスモデル: [memory: キミテラス ビジネスモデル](../../.claude/projects/.../memory/project_kimiterrace_business_model.md)
- 4 Phase 計画: [ROADMAP.md](ROADMAP.md)
- 規律: [CLAUDE.md](../CLAUDE.md)

---

## 直近の完了

- 2026-05-28: 移行方針確定（GCP ネイティブへ全改修）
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
- 2026-05-28: Orchestrator スモークテスト ✅ 完了（PR #26 等 merged、ローカル開発 docker-compose）
- 2026-05-28: **キミテラス v2 AI 機能群の MVP スコープ確定**（本セッション、ユーザー × Claude 議論結果）
- 2026-05-28: **V1（旧 Firebase 版）機能棚卸し完了**（本セッション、Explore agent + 追検証で訂正）
- 2026-05-28: ブランド表記訂正 — 公式名は「キミテラス」で統一（LP の「Edix」表記は誤り）
- 2026-05-28: Mac Mini Worker 健全性確認（RAM 3.4G/Disk 261G/CPU 28%、Claude プロセス 0、spawn 余裕あり）
- 2026-05-28: **`docs/requirements/v2-mvp.md` ドラフト起草完了**（機能要件 F01-F12、非機能要件 NFR01-NFR07、ロール設計、データモデル概念設計、RLS ポリシー、AI 安全網 4 種、PII マスキング戦略、将来追加・未決定事項を一本化）— ユーザーレビュー待ち

---

## 今やっているもの

| 担当 | Issue | タスク | 進捗 |
|---|---|---|---|
| Claude | #11 | 既存システム棚卸し | ✅ 完了（V1 機能インベントリ取得） |
| Claude | #12 | 機能要件 F01-F0X ドラフト | ✅ **v2-mvp.md §4 に集約**（レビュー待ち、その後個別ファイル分割） |
| Claude | #13 | 非機能要件 NFR01-NFR06 ドラフト | ✅ **v2-mvp.md §5 に集約**（レビュー待ち、その後個別ファイル分割） |
| Claude | #14 | ADR 群初稿 | 未着手（v2-mvp.md §12.2 に必要な新規 ADR を 5 本リスト化済） |
| Claude | #15 | PostgreSQL スキーマ DDL 初稿 | 未着手（v2-mvp.md §6 のデータモデル概念設計を基に Drizzle 化） |
| Claude | #16 | C4 図 + シーケンス図 | 未着手 |
| Claude | #17 | 脅威モデル STRIDE | 未着手 |
| Claude | #18 | ローカル開発環境 docker-compose | ✅ 完了（PR #26 merged） |
| 人間 | #19 | gcloud SDK / Terraform インストール | ✅ 完了 |
| 人間 | #20 | GCP プロジェクト `signage-v2-prod` 作成 | ✅ 完了 |
| 人間 | #21 | 県教委 Wi-Fi フィルタ方式問合せ | ✅ 完了（ドメインベース） |
| 人間 | #22 | ペネトレ業者3社見積依頼 | ❌ **実施しない判断（要再検討）** |

---

## 次にやるべき（優先順）

1. **ユーザーレビュー: `docs/requirements/v2-mvp.md`** — レビュー観点はファイル末尾「レビュー観点（ユーザー向け）」参照。確定/修正点を反映してから次へ
2. レビュー反映 → F01-F12 / NFR01-NFR07 個別ファイル分割
3. 新規 ADR 5 本起票（v2-mvp.md §12.2: ADR-015 即公開+安全網、ADR-016 magic link 匿名、ADR-017 Gemini 抽出、ADR-018 CRM 独自、ADR-019 RLS 二層）
4. PostgreSQL スキーマ DDL（Drizzle, v2-mvp.md §6 → `packages/db/schema/*.ts`）
5. C4 図 + シーケンス図（Mermaid, v2-mvp.md §3 ロール + §6 データ + §7 RLS を基に）
6. 脅威モデル（STRIDE, v2-mvp.md §3 ロール + §7 RLS を基に）
7. 各機能を GitHub Issue 化 → 優先順位付け
8. Terraform 雛形（modules + dev environment）
9. Worker spawn で並列実装開始（probe で確認、tmux 儀式実施後）

---

## 詰まり / 確認待ち

- なし（外部要因の詰まりは解消）

## 将来追加機能（後送り・現フェーズ対象外）

- **外部システム自動取込み（Google Calendar / メール / Google Classroom / Classi 等）**:
  サイネージのコンテンツ源を外部システムから自動取得する経路。技術ハードルが高い + 外部連携が増えるとセキュリティ攻撃面が広がるため、**現フェーズ（AI 主導コンテンツ生成 MVP）では実装しない**。
  - 方針: 当面は「**自校システム内で完結する閉じた構成**」を維持する（セキュリティ優先）
  - 将来検討時期: AI 主導コンテンツ生成（ファイル抽出 + 生徒対話）が安定運用に乗ってから
  - 判断者: 2026-05-28 ユーザー判断

---

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
- **2026-05-28**: **ロードマップを 4 Phase 構成 (調査→設計→開発→導入) に再設計**。「W」表記廃止。Claude 担当 = 調査〜開発（staging 完成まで）、導入は人間担当。Phase 名は調査・設計・開発・導入の固有名で扱う（番号付けしない）
- **2026-05-28**: **AI 機能群 MVP スコープ確定**（本セッション、ユーザー × Claude 議論結果）:
  - **教員入力**: ファイル抽出（PDF/Word/Excel/画像）+ 音声 + チャット → AI 構造化 → 即公開
  - **公開フロー**: 即公開、承認なし。代わりに**安全網 4 種**（audit_log・1-click rollback・AI 確信度フラグ・公開先明示）
  - **生徒アクセス**: クラス magic link で個人特定なし、スマホ/タブレットから閲覧 + 音声/チャット Q&A（掲示物に関する質問のみ、学習・進路は Phase 2）
  - **イベントロギング**: タップ・遷移を全部記録 → 効果可視化の元データ
  - **管理者**: 校務管理者（school_id スコープ）+ システム管理者（cross-tenant、奥村さんのみ）
  - **広告主はシステム外** — 月次レポート + 対面コミュニケーションで伝達。直接システムアクセスなし
  - **CRM 機能を独自追加**（広告主マスタ・契約・コミュニケーション履歴、システム管理者のみ）
  - **RLS**: school_id 単層 + system_admin の cross-tenant policy
  - 外部システム連携は将来送り（[将来追加機能] 参照）
  - 詳細はこのセッションで議論、次セッションで `docs/requirements/v2-mvp.md` に書き下す
- **2026-05-28**: **ブランド訂正** — 公開ブランド名は「**キミテラス**」で統一。LP コード（`C:\Users\20051\Desktop\学校DX事業\06_LP\edix-lp\`）に「Edix」表記が残っているが誤り
- **2026-05-28**: **V1 サイネージ表示の所在訂正** — V1 のサイネージ表示エンジンは既に実装されている。場所は `management/src/components/signage/`（`SignagePage.tsx` 等、root `/` ルートが表示エントリ）。トップレベルの `signage-display/` フォルダは空（過去の分離試行の残骸）。V2 では「一から実装」ではなく「Next.js 16 + Cloud Run へ移植」する
- **2026-05-28**: **コスト天井は当面気にしない方針**（ユーザー判断）。ただし不正対策としての rate limiting（生徒チャットの 1 端末あたり/分のクエリ数制限など）はセキュリティ要件として実装する

---

## 既知のリスク

| リスク | 影響度 | 対応 |
|---|---|---|
| 県 Wi-Fi が IP ベースフィルタの場合、Cloud Run 移行で疎通不可 | 高 | 確認待ち。最悪は Firebase Hosting の前段に Cloud Run を置く構成も可 |
| ペネトレテスト見積が予算超過の可能性 | 中 | 3社相見積もり、SaaS型の脆弱性診断（年契約）も検討 |
| 移行中の既存運用学校（岐南工業）への影響 | 中 | 並行運用期間を 2 週間確保、DNS は最後に切替 |
| AI 機能のコスト膨張（Vertex AI Gemini 利用増） | 中 | コスト天井は意図的に設けないがユーザー判断、rate limiting は不正対策として実装する |

---

## セッション履歴

> 各セッションでこの欄に追記する。形式: `YYYY-MM-DD: 何をやったか / 何を残したか`

- **2026-05-28**: プロジェクト初期化、CLAUDE.md・STATUS.md・ROADMAP.md 作成完了、Issue 化はこれから
- **2026-05-28**: 全基盤セットアップ完了。リポジトリ公開、CI/branch protection 設定、W0 Issue #11-#22 登録。次セッションは #11 から着手予定
- **2026-05-28**: 人間タスク (#19-#21) 完了確認、GCP API 有効化、Wi-Fi/GCP/dev-tools の状態を docs/discovery/ に記録。ペネトレ (#22) は不実施判断が出たが要再検討
- **2026-05-28**: Orchestrator スモークテスト ✅ **エンドツーエンド成功**。Mac Mini Worker が Issue #18 を spawn → 実装 → コミット → push → PR #26 自作成、CI 11/11 通過まで完走。Worker は CLAUDE.md ルール（1 PR=1機能、`.env.example` のみコミット、Conventional Commits、テスト計画記載）を全部守った。経路上の encoding バグ 2 件は PR #25 / #27 で修正済み:
  - PR #25: SSH 非対話 PATH に `/opt/homebrew/bin` を補強（M1 Mac の bare `tmux` が見つからない）
  - PR #27: state JSON / brief / driver script を base64 wrap、Get-Content に `-Encoding UTF8`、CRLF→LF 正規化（PowerShell 5.1 → ssh.exe で `"` 消失・mojibake・`\r` 混入が同時発生）
  - 既知の小バグ: `worker-launcher.sh` の PR 番号抽出が macOS BSD `grep -P` 非対応で空。state.prNumber が常に null（機能には影響しない、後続課題）
  - 残課題: Worker 完了の自動検出、Reviewer 自動 spawn は未実装（v0.3）
- **2026-05-28**: **キミテラス v2 AI 機能群 MVP スコープ確定セッション**（本セッション）。
  - **議論経過**: 教員の働き方改革を主軸 → サイネージ前提に絞り込み → ファイル抽出 + 音声 + チャットを軸に → 生徒のスマホ/タブレット対話を追加 → 広告主はシステム外で月次レポート受信 → システム管理者ロール導入 → CRM 機能追加
  - **MVP 確定機能**: 教員側ファイル抽出（PDF/Word/Excel/画像）+ 音声/チャット入力 + 即公開+安全網 4 種、生徒側スマホ/タブレット対話（クラス magic link、掲示物 Q&A のみ）、システム管理者向け効果可視化ダッシュボード + AI 効果コメント自動生成 + 月次レポート（PDF/手動配布）、独自設計の CRM 機能（広告主マスタ・契約・コミュニケーション履歴）
  - **V1 棚卸し**: 管理 UI・サイネージ表示・広告階層マージ・LiDAR センサーは実装済（サイネージ表示は `management/src/components/signage/` に統合）。QR/タップ/滞留計測と広告主エンティティは未実装 → V2 で追加
  - **Mac Mini Worker パイプライン**: probe 健全性確認 ✅（spawn 余裕あり）
  - **memory 更新**:
    - 新規: `project_kimiterrace_business_model.md`（ビジネスモデル・PoC・ロール構造）
    - 新規: `feedback_closed_system_security.md`（外部連携より自校内完結を優先）
    - 削除: `project_signage_deployment_milestones.md` / `feedback_signage_verify_preview_channel.md`（旧 Firebase プロジェクトの陳腐化メモ）
  - **次セッション entry point**: **`docs/requirements/v2-mvp.md` 起草**（このセッションの議論結果を 1 ファイルにまとめる）から再開。タスクトラッキング（TaskCreate）はセッション間で持ち越されないため、再開時に上記「次にやるべき」優先順をもとに TaskCreate で再構築する
- **2026-05-28**: **`docs/requirements/v2-mvp.md` ドラフト起草完了**。前セッションで確定した AI MVP スコープを 1 ファイルに集約: §1 概要 / §2 設計原則 / §3 ロール設計（権限マトリクス含む）/ §4 機能要件 F01-F12 / §5 非機能要件 NFR01-NFR07 / §6 データモデル概念設計（テーブル分類 + 主要 17 テーブル）/ §7 RLS ポリシー設計（単層 + system_admin cross-tenant）/ §8 AI 安全網 4 種詳細 / §9 PII マスキング戦略 / §10 将来追加機能 / §11 未決定事項 / §12 関連 ADR・Issue。末尾に「レビュー観点（ユーザー向け）」セクションを追加し、レビューポイント 6 件を明示。次セッション entry point: **ユーザーレビュー結果の反映 → F01-F12 / NFR01-NFR07 個別ファイル分割 → ADR 5 本起票**
