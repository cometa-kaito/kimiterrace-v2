# プロジェクト現在地

> このファイルは Claude Code セッションの起点。新セッションは必ずこれを読む。
> セッション終了時に必ず更新する。

最終更新: 2026-05-29 (Part A/B 着地、Terraform PR #66 draft、orchestrator local-windows ブロッカー連発で停止中)
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

- 2026-05-29: **Part B 群完走 + Terraform PR 着地サイクル**: PR #54 (STRIDE Part A merged)、PR #63 (シーケンス Part B 教員系 5 種 merged)、PR #64 (STRIDE Part B Repudiation+InfoDisclosure merged)、PR #66 (Terraform 雛形 873 行追加 draft, CI 11/11 green)。Reviewer #66 spawn 中
- 2026-05-29: **orchestrator バグ修正**: `lib/state.ps1` の `[int]$Pid` param が PowerShell automatic variable と衝突 → `$ProcessId` リネーム (`orchestrator.ps1:230` 呼出側も合わせて修正)
- 2026-05-29: **Mac mini 一時 disable**: SSH 解決不可のため `config.json` で disable、local Windows 単独運用へ。RAM 5GB しか空きなく Reviewer/Worker は逐次運用
- 2026-05-29: **orchestrator local-windows ブロッカー連発**:
  - **bash 解決バグ (修正済)**: `Start-Process "bash"` が Windows の WSL launcher (`C:\Windows\System32\bash.exe`) を起動し WSL 未インストールで即死 → log 一切なし → Sync が PID dead を `completed` と誤判定。修正: `config.json` に `bashPath` を追加 (`C:\Program Files\Git\bin\bash.exe` 直指定)、`orchestrator.ps1` でこれを参照。
  - **Sync 誤判定バグ (修正済)**: log が存在しなくても `completed` 扱いだった → log 不在は launcher 起動失敗の証拠として `failed (-1)` に変更 (`lib/state.ps1`)。
  - **🚨 残ブロッカー: `claude` CLI 401**: launcher 起動後、`claude` が `API Error: 401 Invalid authentication credentials` で即死。Worker / Reviewer spawn 不能。Mac は Keychain 経由でサブスク認証していたが、local Windows ではその経路がない / Start-Process hidden で TTY なし → interactive auth が走らない。次セッションでユーザーが claude login 状態確認 + Worker 起動方式（API key 経由 or 別 user session）の見直しが必要。
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
- 2026-05-28: **`docs/requirements/v2-mvp.md` ドラフト起草完了**（機能要件 F01-F12、非機能要件 NFR01-NFR07、ロール設計、データモデル概念設計、RLS ポリシー、AI 安全網 4 種、PII マスキング戦略、将来追加・未決定事項を一本化）
- 2026-05-28: **要件個別ファイル分割完了**（functional/F01-F12 12 本 + non-functional/NFR01-NFR07 7 本 + 索引 README 2 本 = 21 ファイル新規作成）。v2-mvp.md は概観・横断要素の参照源として維持
- 2026-05-28: **ADR-015〜019 起草完了**（即公開+安全網 / magic link 匿名 / Gemini + confidence / CRM 独自 / RLS 二層）。各 ADR は文脈・決定・代替案・トレードオフのフォーマット遵守、関連 F・NFR・memory への双方向リンク含む
- 2026-05-28: **Orchestrator 規律厳格化**（ユーザー提示の並列フロー + PR レビューフローを正式採用）:
  - Desktop の Edit/Write は **メタ規律ドキュメント限定**（CLAUDE.md / STATUS.md / ROADMAP.md / runbooks / memory / scripts/orchestrator/templates）
  - 運用 docs は **すべて Worker 経由**（docs/requirements / adr / architecture / compliance / apps / packages / infrastructure）
  - Reviewer Claude を **PR ごとに別 spawn**、`/code-review` skill + CLAUDE.md 8 ルール + F/NFR/ADR + STRIDE
  - Reviewer は `gh pr review --approve/--comment/--request-changes` で判定 submit、Desktop が CI green + APPROVE 確認後に merge
  - STATUS.md / メタ規律ドキュメントは Desktop の責務、Worker / Reviewer は触らない
  - 1サイクル Desktop context 消費 ~6,000 tokens 目標 → 1 セッション 50〜100 サイクル設計
  - memory `feedback_orchestrator_commit_authority.md` を「docs hygiene 全部 OK」→「メタ規律のみ OK」に範囲縮小
  - memory `feedback_worker_review_discipline.md` を新規追加（CI 確認 → /code-review → CLAUDE.md 8 ルール の手順）
  - `scripts/orchestrator/templates/reviewer-brief.md.template` を新フローで全面改稿
- 2026-05-28: **Worker spawn 半失敗** — Issue #15 (DDL) が `workerMaxBudgetUsd=5` で停止（17 テーブル一気は粒度過大）、Issue #17 (STRIDE) が spawn 漏れ、Issue #16 (C4) が走行中。教訓を新規 memory [[worker-task-granularity]] に保存（Worker 用 Issue は budget 5 USD = ≒500 行で完走できる粒度に Desktop 事前分割）。rate_limit utilization 91% でユーザー報告により 4 分後リセット → 次セッションで Issue 細分化 + 再 spawn する流れ
- 2026-05-28: **Issue 細分化 + 再 spawn 成功**:
  - Issue #15 / #16 / #17 を Part A/B/C に分割する方針確定。本サイクルでは Part A だけ作成: **#49** (DDL Part A = テナント分離 9 テーブル + 共通基盤、salvage ヒント付き) / **#50** (C4 Part A = Context/Container/Component + ER) / **#51** (STRIDE Part A = Spoofing + Tampering)
  - Worker #50 が初回 spawn で完走 → **PR #52** 着地 (C4 + ER Mermaid)、CI 全 green
  - Worker #49 初回 spawn は `$5` budget 枯渇で uncommit（pnpm install + lint/typecheck の setup コスト過大）→ **`workerMaxBudgetUsd` を 5 → 8 にチューニング** (`scripts/orchestrator/config.json`)
  - Worker #49 再 spawn は `$3.86` で完走 → **PR #53** 着地。ただし CI で `Dependency Review` 失敗あり（drizzle-orm / postgres-js のライセンス確認要、Reviewer 判断）
  - Worker #51 (STRIDE) は **2 連続 spawn の 2 番目で hang する症状**を 2 回再現（state JSON は作成されるが launcher 起動せず、log なし）。SSH 多重化由来の疑い → **当面 spawn は solo で運用**。本サイクル末で #51 単独 spawn 中
  - 反映先 memory: [[worker-task-granularity]] と新規 [[worker-budget-by-task-type]]（setup-heavy=$8、prose=$5）
  - 反映先 template: `scripts/orchestrator/templates/reviewer-brief.md.template` の `{{PR_NUMBER}}` → `{{ISSUE_NUMBER}}` トークン名修正（orchestrator.ps1 が substitution する変数名と不一致だったバグ）

---

## 今やっているもの

| 担当 | Issue | タスク | 進捗 |
|---|---|---|---|
| Claude | #11 | 既存システム棚卸し | ✅ 完了（V1 機能インベントリ取得） |
| Claude | #12 | 機能要件 F01-F0X ドラフト | ✅ **`functional/F01-F12.md` 個別分割済** |
| Claude | #13 | 非機能要件 NFR01-NFR06 ドラフト | ✅ **`non-functional/NFR01-NFR07.md` 個別分割済**（NFR07 追加） |
| Claude | #14 | ADR 群初稿 | ✅ **ADR-015〜019 起票済**（既存 ADR-001〜014 と合わせて 19 本） |
| Worker(Mac) | #15 | PostgreSQL DDL 初稿 | 🔀 **Part A/B/C 分割**。Part A 完走 (PR #53 merged)、Part B (#55) / Part C (#58, #59) 未着手 |
| Worker(Mac) | #16 | C4 図 + シーケンス図 | 🔀 **Part A/B/C 分割**。Part A 完走 (PR #52 merged)、Part B 完走 (PR #63 merged)、Part C (#60) 未着手 |
| Worker(Mac) | #17 | 脅威モデル STRIDE | 🔀 **Part A/B/C 分割**。Part A 完走 (PR #54 merged)、Part B 完走 (PR #64 merged)、Part C (#61) 未着手 |
| Worker(Mac) | #49 | DDL Part A (9 テナント表 + 共通基盤) | ✅ **PR #53** merged |
| Worker(Mac) | #50 | C4 Part A (Context/Container/Component+ER) | ✅ **PR #52** merged |
| Worker(Mac) | #51 | STRIDE Part A (Spoofing+Tampering) | ✅ **PR #54** merged |
| Worker(Mac) | #56 | シーケンス Part B (教員系 5 種) | ✅ **PR #63** merged |
| Worker(Mac) | #57? | STRIDE Part B (Repudiation+InfoDisclosure) | ✅ **PR #64** merged |
| Worker(Local) | #65 | Terraform 雛形 (providers + GCS state + 5 modules + 3 envs) | 🔄 **PR #66** draft、CI 11/11 green、Reviewer spawn 済 |
| Claude | #18 | ローカル開発環境 docker-compose | ✅ 完了（PR #26 merged） |
| 人間 | #19 | gcloud SDK / Terraform インストール | ✅ 完了 |
| 人間 | #20 | GCP プロジェクト `signage-v2-prod` 作成 | ✅ 完了 |
| 人間 | #21 | 県教委 Wi-Fi フィルタ方式問合せ | ✅ 完了（ドメインベース） |
| 人間 | #22 | ペネトレ業者3社見積依頼 | ❌ **実施しない判断（要再検討）** |

---

## 次にやるべき（次セッション entry point）

> **重要 (2026-05-29)**: Mac mini が SSH 到達不可（Tailscale / 電源 / tmux 儀式どれか）→ `config.json` で **一時 disable**（次回ユーザー Mac 起動時に re-enable）。local Windows のキャパは **RAM 5GB しか空きがなく Reviewer/Worker 各 1 slot のみ** → 並列不可、シーケンシャル運用。

1. **Reviewer #66 (Terraform skeleton) 完了確認** → APPROVE/CI green なら Desktop が draft 解除 + merge、REQUEST_CHANGES なら Worker #65 を修正再 spawn
2. **Worker #60 (シーケンス Part C: 生徒系・分析系) を spawn**（Reviewer #66 完了後、local Windows）
3. **次サイクル: 残 Part B / C を順次**:
   - **#55** DDL Part B（AI/RAG 系: `ai_extractions` / `ai_chat_sessions` / `ai_chat_messages` / pgvector index）
   - **#58** DDL Part C1（CRM + 横断系: advertisers / contracts / communications / monthly_reports / system_admins / audit_log）
   - **#59** DDL Part C2（RLS migration + audit_log trigger + RLS tests）
   - **#61** STRIDE Part C（DoS + EoP + 即公開フロー特有）
4. **F01-F12 着手は #59 (RLS テスト) 完了後**（テナント漏れ防止の Critical pre-req）
5. **Mac mini 復活**:
   - ユーザーが Mac 起動 + Terminal.app から `tmux new -s workers` → Desktop が `config.json` の `mac-mini.enabled` を `true` に戻す
   - SSH 解決 fallback 試行: `Kaitos-Mac-mini.local` (LAN) or Tailscale IP
6. **解決すべき orchestrator バグ**:
   - 2 連続 spawn の 2 番目が hang（SSH 多重化由来の疑い）→ `Start-RemoteWorker` 内で SSH 接続を独立化する PR を別途
   - ✅ **修正済 (2026-05-29)**: `lib/state.ps1` の `[int]$Pid` param が PowerShell automatic variable `$PID` と衝突して spawn 起動不可 → `$ProcessId` にリネーム

## 詰まり / 確認待ち

- **🚨 [BLOCKER] local Windows での `claude` CLI 401**: Start-Process で起動した launcher 経由の `claude` が `API Error: 401 Invalid authentication credentials` で即死。サブスク認証が hidden process に伝わらない可能性。Mac は Keychain で解決していたが Windows 経路は未確立。**Worker spawn 全停止**。要対応:
  1. `claude` CLI が現在の Windows user で対話的にログイン済か確認 (`claude` 起動 → / コマンドで session 確認)
  2. Hidden process でも認証が拾える設定 (例: `ANTHROPIC_API_KEY` 環境変数 or Workload identity) の確立
  3. または Mac mini 復活でこの問題を一旦回避
- **Mac mini SSH 到達不可** (`ssh: Could not resolve hostname kaitos-mac-mini`): Tailscale / 電源 / tmux 儀式の確認待ち
- **worker-launcher.sh の prNumber 抽出バグ**: macOS BSD `grep -P` 非対応で state.prNumber が常に null（既知、後続課題）

---

## 詰まり / 確認待ち (旧版、新規は「次にやるべき」直下)

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
- **2026-05-28**: **`docs/requirements/v2-mvp.md` ドラフト起草完了**。前セッションで確定した AI MVP スコープを 1 ファイルに集約: §1 概要 / §2 設計原則 / §3 ロール設計（権限マトリクス含む）/ §4 機能要件 F01-F12 / §5 非機能要件 NFR01-NFR07 / §6 データモデル概念設計（テーブル分類 + 主要 17 テーブル）/ §7 RLS ポリシー設計（単層 + system_admin cross-tenant）/ §8 AI 安全網 4 種詳細 / §9 PII マスキング戦略 / §10 将来追加機能 / §11 未決定事項 / §12 関連 ADR・Issue。末尾に「レビュー観点（ユーザー向け）」セクションを追加し、レビューポイント 6 件を明示
- **2026-05-28**: **要件個別ファイル分割完了**。v2-mvp.md から `docs/requirements/functional/F01-F12.md`（12 本）と `docs/requirements/non-functional/NFR01-NFR07.md`（7 本）に分割。索引 README 2 本も作成。v2-mvp.md は概観・横断要素（ロール / データモデル / RLS / 安全網詳細 / PII / 関連 ADR）の参照源として維持。NFR07 (コンプライアンス) を v2-mvp.md §5 から個別ファイルに昇格（元 issue #13 は NFR01-NFR06 を想定していたが、コンプライアンスを独立化）
- **2026-05-28**: **ADR-015〜019 起草完了**（5 本）。各 ADR は README フォーマット（文脈・決定・検討した代替案・結果/トレードオフ）に厳格準拠。トレードオフ節を必ず明記。詳細:
  - [ADR-015](../adr/015-instant-publish-with-safety-nets.md): 即公開 + 安全網 4 種。承認フロー非採用の根拠（公立校階層特性 + 紙時代慣例 + AI 抽出は教員一次レビュー前提）。代替案 4 件却下
  - [ADR-016](../adr/016-class-magic-link-anonymous-access.md): クラス magic link 匿名アクセス。個別アカウント・学校 SSO・OTP メール・アクセス自由を却下。漏洩リスクは cryptographic randomness + 90 日デフォルト + 即時失効フローで抑制
  - [ADR-017](../adr/017-gemini-ai-structuring-with-confidence.md): Gemini Pro 固定 + native JSON mode + Zod validate + リトライ最大 2 回 + confidence_score 必須化 + evidence 引用。Claude/GPT/Azure を却下（GCP 内完結優先）
  - [ADR-018](../adr/018-custom-crm-design.md): CRM 独自設計（HubSpot / Salesforce / Notion / スプレッドシート却下）。広告主 20 社規模に SaaS コストは過剰、F09 月次レポートとの JOIN が同一 DB で完結する利点
  - [ADR-019](../adr/019-rls-two-layer-tenant-isolation.md): RLS 二層分離。レイヤー 1: school_id テナント分離、レイヤー 2: system_admin cross-tenant policy。アプリ層フィルタ・スキーマ分離・物理分離・SECURITY DEFINER を却下。CRM テーブルは RLS 対象外（middleware で system_admin チェック）
  - 次セッション entry point: **Drizzle DDL (Worker spawn 必須) → C4 図 + STRIDE (Desktop) → Issue 化**
- **2026-05-29**: **Part B + Terraform サイクル完走**。直前セッションで Part A 群 (#52/#53/#54) を merge、本セッション開始時には Part B 群 (#63 シーケンス教員系 / #64 STRIDE Repudiation+InfoDisclosure) と Terraform PR #66 (draft, CI 11/11 green) が着地済み。
  - Mac mini SSH 解決不可 (`kaitos-mac-mini`) → `config.json` で `mac-mini.enabled=false` に一時切替、local Windows 単独運用
  - orchestrator spawn 起動バグ修正: `lib/state.ps1` の `[int]$Pid` param が PowerShell automatic variable と衝突 → `$ProcessId` リネーム
  - Reviewer Claude を **PR #66 (Terraform)** に spawn (PID 10276, local Windows)。完了通知待ち
  - 残: Worker #60 (シーケンス Part C 生徒系・分析系) は Reviewer #66 完了後に逐次 spawn（local RAM 5GB 制約で並列不可）
