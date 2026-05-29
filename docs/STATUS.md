# プロジェクト現在地

> このファイルは Claude Code セッションの起点。新セッションは必ずこれを読む。
> セッション終了時に必ず更新する。

最終更新: 2026-05-29 (PR #85 Terraform root cleanup + PR #93 DDL Part C2 + PR #97 dormant bug 修正サイクル merged。Issue #59 / #69 / #96 close。**Operating Mode を Busy CEO に切替** — orchestrator + Worker 兼任、Reviewer/CI 経由の意思決定は自律実行 OK、詳細は [CLAUDE.md](../CLAUDE.md) Operating Mode セクション + [[busy-ceo-mode]] memory)
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

- 2026-05-29: **PR #85 Terraform cleanup + PR #93 DDL Part C2 + PR #97 dormant bug 修正サイクル (Worker → Reviewer → Worker mode 引継 → 修正 PR の 3 段リレー)**:
  - **PR #85 (Worker #69 Terraform root cleanup、+5 / -105、CI 11/11 green)**: Agent + worktree isolation で spawn した Worker が方針 A (root .tf 群 5 ファイル削除 + envs/*/main.tf 一本化) を ~4 分で完走。Reviewer Agent APPROVE / Critical 0 / High 0 → admin squash merge (commit `9357b5d`)。**Issue #69 close**
  - **PR #93 (Desktop Worker mode #59 DDL Part C2、+4156 / -2、CI 12/12 green、ただし RLS テスト全 skip)**: 並列で spawn した Worker (Agent + worktree isolation) が **ローカル Docker 不在で Testcontainers 起動できず ~23 分停滞** → ユーザー判断で「Desktop が Worker mode で引き継ぎ」。Worker 成果物 (migration 3 + テスト 2 + setup 3) を流用、残り 3 テスト (audit-columns / audit-log-append-only / audit-log-hash-chain) を Desktop が実装。設計は **Testcontainers 採用せず DATABASE_URL 環境変数で実 PG に接続、未設定なら skip** に切替 (CI で実 PG 起動は別 Issue で対応推奨)。`feat/59-ddl-part-c2` / `v2` は過去 spawn 残骸の branch、`v3` は並行ユーザーの branch hijack 経路、最終的に **`v4` で完走 + 並行ユーザー停止依頼後に commit**。Reviewer Agent が Critical 2 (test の schema 不整合) + High 2 (RLS policy 不足) を指摘 → ユーザーが Issue #96 として別 PR スコープに切り出し、**PR #93 は merge** (commit `e3d5791`)。**Issue #59 close**
  - **PR #97 (Issue #96 fix C1/C2/H1/H2、+145 / -12、CI 12/12 green)**: ユーザーが起票した Issue #96 (PR #93 Reviewer 指摘のうち実 DB 起動時のみ顕在化する dormant bug 4 件) を Desktop Worker mode で修正。**C1**: tenant-isolation.test.ts の存在しないカラム `body_markdown` → schema 通り `body` + NOT NULL の `publish_scope` 追加 / **C2**: 新規 `migrations/0004_audit_fk.sql` で 18 テーブル × 2 カラム (`created_by`/`updated_by`) に `users(id)` FK 追加 (`ON DELETE SET NULL`、idempotent DROP/ADD) / **H1**: `global-setup.ts` の `DROP SCHEMA public CASCADE` ガード (`KIMITERRACE_TEST_DB_OK=1` / localhost 系 host / DB 名 test 含有 のいずれかを要求) / **H2**: vitest.config.ts に `pool: 'forks'` + `singleFork: true` 明示 + README で文書化 / 派生: crm-system-admin.test.ts の `communications` INSERT に NOT NULL の `occurred_at` 追加 (Reviewer Critical 3、Issue #96 外だが実 DB 前提)。Reviewer APPROVE → admin squash merge (commit `c1be545`)。**Issue #96 close**
  - **並行ユーザー作業との衝突 (重要な学び)**: 本サイクル中、別セッション (Cursor or 別 Claude) で WIF module (PR #90)、observability scaffold (PR #91)、apps/web Next.js scaffold (PR #92) が並行進行。Desktop の `feat/59-ddl-part-c2-v3` branch を **2 回連続で `local/redo-87` / `local/redo-88` に強制 checkout** され untracked file は保持されたが tracked file 状態が壊れる現象を検知。ユーザーに並行セッション停止を要請 → 独占時間で `v4` branch + commit + push 完走。並行作業前提では git operation の冪等性が崩れるため、(a) `git fetch` + `git checkout` を Desktop が頻繁に行わない、(b) untracked file 中心の操作にする、等の運用工夫が必要 (memory 候補)
  - **Reviewer 投稿 hygiene 再発**: PR #93 Reviewer Agent (a95e3...) が `gh pr review` 投稿スキップ → Desktop が代理投稿。PR #97 Reviewer は投稿成功 (ただし PowerShell here-string の `@` 文字混入、内容は legible)。**Reviewer brief の Step 4-A を最重要マイルストーンとして明示**する改善は実施済も、依然として失敗事例ゼロにならず。PR #84 / #93 / #97 で 1/3 失敗率
  - **Worker → Desktop 引継 vs 新 Agent spawn**: Worker が hang した時、SendMessage tool が現環境で deferred list / available list 両方に存在しないため Agent への直接メッセージング不能。選択肢 (新 Agent spawn / Desktop Worker mode 引継 / Docker 待ち / 中断) からユーザーが **Desktop Worker mode** を選択 → 既存 worktree から成果物コピー + 残作業実装で完走。「Worker hang 時に Desktop が引き継ぐ」は memory `feedback_pr_merge_authority.md` や `worker-task-granularity.md` と並ぶ規律候補
  - **残課題 (本サイクル外)**: PR #93 Reviewer の **High 4** (schools tenant_isolation FOR ALL 不在) / **High 5** (audit_log_insert WITH CHECK actor_user_id 詐称防止) / **High 7** (turbo.json passThroughEnv に DATABASE_URL) / Medium-Low 8-15 は別 Issue 起票推奨 (本セッションでは未起票、次セッション最優先候補)
  - **本サイクル成果**: 3 PR (#85 / #93 / #97) + 並行ユーザー 3 PR (#90 / #91 / #92) merged、Issue #59 / #69 / #96 close。Desktop context 消費 大 (Worker hang 検出 + Desktop Worker mode 引継 + branch hijack 復旧 + Reviewer 代理投稿 + 修正 PR で ~60k tokens、通常 orchestrator サイクル 6,000 token 目標を 10 倍超過)
- 2026-05-29: **PR #84 terraform fmt micro-fix サイクル (Issue #83 close)**:
  - **検知経路**: ユーザーが `terraform fmt -recursive infrastructure/terraform/` 実行時に `infrastructure/terraform/modules/identity_platform/main.tf` の `google_identity_platform_tenant.school` リソース引数 alignment ずれを発見。`allow_password_signup` (21 文字) が他の引数より長いのに `=` が縦揃いしていなかった
  - **規律遵守確認**: ユーザーは Desktop に「直接やる」選択肢を提示したが、Desktop 側で「`infrastructure/` は Worker 経由」(CLAUDE.md Orchestrator Mode) を flag → ユーザー判断で Worker spawn + 新規 Issue ルート選択 → Issue #83 起票 → Agent + worktree isolation で Worker spawn
  - **PR #84 (+2 / -2、1 ファイルのみ)**: `terraform fmt -recursive` で `project` / `display_name` の `=` 直前 spaces を 1 ずつ増やし `allow_password_signup` の `=` 位置に揃え。semantics 変更ゼロ、他ファイル drift なし
  - **Reviewer 規律も遵守 (whitespace-only PR でも skip しない選択)**: Reviewer Agent spawn → CI 11/11 green / Critical 0 / High 0 / Confidence 高 → 同一アカウント self-review 制約で `--comment` 投稿 (本文に「APPROVE 推奨」明記)。投稿時に PowerShell here-string の `@` 文字混入を `updatePullRequestReview` mutation で修正、本サイクルで投稿 hygiene の追加注意点として記録
  - **merge**: `gh pr merge --squash --delete-branch --admin` で commit `5d09bf0` 着地。ローカル branch 削除は Worker worktree 参照中で失敗 (無害な残骸、後続セッションで掃除可)
  - **本サイクル成果**: 1 PR (#84) / Issue #83 close / Desktop context 消費 軽量 (whitespace 1 ファイルにつき orchestrator サイクル目標 ~6,000 tokens 圏内)
  - **学び**: 「tiny PR (whitespace fmt のみ)」でも infrastructure/ なら Worker 経由 + Reviewer skip しない、というユーザーの規律遵守判断を実装で確認。今後 fmt-only PR の例外ルール化は不要 (1 サイクル分のコストは許容範囲)
- 2026-05-29: **PR #76 pgvector hoist + PR #77 DDL Part C1 + PR #80 cloud_sql var 連鎖 merge (Desktop Worker mode 連鎖 2 サイクル目)**:
  - **PR #76 (pgvector hoist、22 行追加 / 27 行削除、純減 -5 行)**: `_shared/pgvector.ts` に `VECTOR_DIM = 768` + `vector` customType を hoist。`content-versions.ts` / `ai-chat-messages.ts` のローカル重複宣言を削除し共有 module import に置換。drizzle-kit 生成 SQL は不変 (dimension 768 維持、マイグレーション差分なし)。Reviewer APPROVE (Critical 0 / High 0、CI 11/11 green)。**Issue #74 自動 close**
  - **PR #77 (DDL Part C1、277 行追加)**: CRM 系 3 + 横断系 3 = 6 テーブル (`advertisers` / `contracts` / `communications` / `monthly_reports` / `system_admins` / `audit_log`) を Drizzle スキーマに追加。`monthly_reports` のみ school_id (テナント分離)、他 5 テーブルは cross-tenant。既存 enum (`contractStatus` / `communicationChannel` / `auditOp`) 再利用、新規 enum なし (CLAUDE.md ルール 3)。`audit_log` は `prev_hash` / `row_hash` SHA-256 hash chain skeleton (NFR04、trigger 実装は #59 で同梱)。Reviewer 実質 APPROVE (Critical 0 / High 0、Medium 3 / Low 4 は #59 Part C2 で吸収可)。CI 11/11 green
  - **PR #80 (ユーザー直接実装、Issue #70 follow-up)**: `cloud_sql` module に `deletion_protection` bool variable 追加。Issue #70 closed
  - **Reviewer 規律改善**: 前サイクルの「`gh pr review` 投稿スキップ」を Reviewer brief に明示警告として追加 (本サイクル分の Reviewer 2 体は両方とも投稿成功)
  - **#67 branch 奪い症状再発**: PR #77 merge 後に Desktop が `worker/58-ddl-part-c1` ブランチに居る状態を発見、`git checkout main && pull` で復旧。Reviewer brief で `gh pr checkout 禁止` を明示済だが、Agent + worktree isolation 経路でも Desktop cwd に branch が作成される現象 → 別経路 (worktree post-cleanup？) を疑う、要追加調査
  - **本サイクル成果**: 2 PR (#76 / #77)、1 ユーザー PR (#80)、Issue #74 / #58 / #70 close、Desktop context ~30k tokens
- 2026-05-29: **PR #71 DDL Part B + PR #72 STRIDE Part C 並列 merge (Desktop Worker mode 2 並列パターン確立)**:
  - **Worker spawn 不可状態を Desktop Worker mode 2 並列で迂回**: local RAM 3.7GB → orchestrator plan で worker capacity 0 slot 判定 (1200×1.2=1440MB の per-proc budget が desktop reserve 2500MB 控除後 1245MB に届かず)。Agent tool + `isolation: worktree` で 2 task を並列実行
  - **PR #71 (DDL Part B、167 行追加、CI 11/11 green)**: AI/RAG 3 テーブル (`ai_extractions` / `ai_chat_sessions` / `ai_chat_messages`) を Drizzle スキーマに追加。confidence_score real NOT NULL + evidence jsonb (ADR-017)、pgvector(768) (ADR-007)、PII マスキング JSDoc 明記 (CLAUDE.md ルール 4)、school_id FK + auditColumns 全準拠。Reviewer COMMENT 判定 (Critical 0 / High 2 → follow-up Issue 化、Medium 4 / Low 1)
  - **PR #72 (STRIDE Part C、253 行追加、CI 11/11 green)**: `docs/architecture/threat-model.md` に DoS 4 / EoP 4 / 即公開特有 2 = 10 件追加。Part A+B+C 合算で STRIDE 6 カテゴリ全件 3 件以上達成 (S 4 / T 4 / R 4 / I 7 / D 4 / E 4 + P 2 = 29 件)。Reviewer 実質 APPROVE (Critical 0 / High 0 / Low 1 は path typo)。**親 Issue #17 自動 close**
  - **follow-up Issue 起票**: **#73** (composite FK で cross-tenant 整合を DB 強制、プロジェクト横断) / **#74** (pgvector customType を `_shared/pgvector.ts` に hoist) / **#75** (M-1〜M-4 bundle: status enum 化 + raw_input_hash 整合 + composite index + class_id index)
  - **Reviewer Bot の `gh pr review` 投稿スキップ**: #71 Reviewer Agent が分析返却のみで GitHub 投稿せず → Desktop が代理投稿 (Reviewer brief の Step 4/5/6 を明示する必要、template 改稿候補)
  - **本サイクル成果**: 2 PR (#71 / #72)、3 follow-up Issue (#73 / #74 / #75)、親 Issue #17 完結。Desktop context 消費 ~25k tokens (Worker mode 2 並列 + Reviewer 2 並列)
- 2026-05-29: **PR #66 + #68 連続 merge サイクル (Desktop Worker mode 初投入)**:
  - **claude CLI 401 blocker 解消**: `~/.claude/.credentials.json` の OAuth token が古かった (2026-02-12)。ユーザーが別ターミナルで `claude` 起動 → 自動 refresh で credentials 更新 (5/29 8:59) → spawn 成功。原因は Claude Desktop (`%APPDATA%\Claude\config.json` の `oauth:tokenCache`) と claude CLI (`~/.claude/.credentials.json`) が**認証保存場所を別管理**しており、Desktop アプリ動作中でも CLI 側 token は別 lifecycle。
  - **Reviewer #66 (Terraform PR) spawn → COMMENT 判定 → squash merge**: Critical 0, High 2 (root .tf 整理 → Issue #69 / cloud_sql deletion_protection 変数化 → Issue #70), Medium 3, Low 3, CI 11/11 green, Confidence 高 → admin merge (commit 5872223)
  - **Desktop Worker mode で Issue #60 (シーケンス Part C 生徒系・分析系) 実装**: Reviewer #66 並列走行中の遊休時間を活用。worktree `../.kimiterrace-workers/desktop-issue-60` で隔離。4 ファイル + README 索引更新 = 578 行追加。**PR #68** 作成 → Reviewer #68 APPROVE (Critical 0 / High 0 / Confidence 高 / CI 11/11 green / 同一アカウントのため `--comment` 投稿) → squash merge (commit c28e488)
  - **親 Issue #16 (C4 + シーケンス) 完結**: Part A (#52 C4 Context/Container/Component+ER) + Part B (#63 教員系 5 シーケンス) + Part C (#68 生徒系・分析系 4 シーケンス) すべて main 着地
  - **Reviewer worktree バグ Issue #67 起票**: `worker-launcher.sh:71-86` で Reviewer は意図的に worktree なしで `$REPO_ROOT` で動く設計 (read-only + pnpm install スキップ軽量化)。だが Reviewer が `gh pr checkout` を呼ぶと Desktop の current branch を奪う副作用。修正方針 A (テンプレ修正のみ) / B (Reviewer も worktree 化) / C (両方) の選択肢を提示
  - **本サイクル成果**: 5 PR (#66 / #68 直接、フォローアップ Issue #67 / #69 / #70)、Desktop context 消費 ~30,000 tokens (Worker mode で context 多めに消費、通常 orchestrator サイクル ~6,000 token 目標を超過)
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
| Worker(Mac) | #15 | PostgreSQL DDL 初稿 | 🔀 **Part A/B/C 分割**。Part A 完走 (PR #53)、Part B 完走 (PR #71)、Part C1 完走 (PR #77)、Part C2 (#59) 未着手 |
| Worker(Mac) | #16 | C4 図 + シーケンス図 | ✅ **完結**。Part A (PR #52 merged) + Part B (PR #63 merged) + Part C (PR #68 merged, Desktop Worker mode) |
| Worker(Mac) | #17 | 脅威モデル STRIDE | ✅ **完結**。Part A (PR #54 merged) + Part B (PR #64 merged) + Part C (PR #72 merged, Desktop Worker mode) — STRIDE 6 カテゴリ全件 3 件以上 + 即公開特有 2 件 = 29 件 |
| Worker(Mac) | #49 | DDL Part A (9 テナント表 + 共通基盤) | ✅ **PR #53** merged |
| Worker(Mac) | #50 | C4 Part A (Context/Container/Component+ER) | ✅ **PR #52** merged |
| Worker(Mac) | #51 | STRIDE Part A (Spoofing+Tampering) | ✅ **PR #54** merged |
| Worker(Mac) | #56 | シーケンス Part B (教員系 5 種) | ✅ **PR #63** merged |
| Worker(Mac) | #57? | STRIDE Part B (Repudiation+InfoDisclosure) | ✅ **PR #64** merged |
| Worker(Local) | #65 | Terraform 雛形 (providers + GCS state + 5 modules + 3 envs) | ✅ **PR #66** merged (admin squash, commit 5872223)。High 2 件は #69 / #70 で follow-up |
| Worker(Desktop) | #60 | シーケンス Part C (生徒系: F05/F06 + 分析系: F07/F09) | ✅ **PR #68** merged (squash, commit c28e488)。Desktop が Worker mode で実装 |
| Worker(Desktop) | #55 | DDL Part B (AI/RAG 3 テーブル) | ✅ **PR #71** merged (squash, commit 25bdc68)。Desktop Worker mode 並列実装、Reviewer COMMENT 判定。Critical 0 / High 2 → #73 / #74、Medium 4 → #75 |
| Worker(Desktop) | #61 | STRIDE Part C (DoS + EoP + 即公開特有) | ✅ **PR #72** merged (squash, commit 64be2b1)。Desktop Worker mode 並列実装、Reviewer 実質 APPROVE。親 Issue #17 自動 close |
| Worker(Desktop) | #58 | DDL Part C1 (CRM + 横断系 6 テーブル) | ✅ **PR #77** merged (squash, commit 223736a)。Desktop Worker mode 並列実装、Reviewer 実質 APPROVE。Medium 3 / Low 4 は #59 Part C2 で吸収予定 |
| Worker(Desktop) | #74 | pgvector customType hoist | ✅ **PR #76** merged (squash, commit 42b54f6)。軽量 refactor、Reviewer APPROVE。Issue #74 自動 close |
| 人間 | #70 | cloud_sql deletion_protection 変数化 | ✅ **PR #80** merged (ユーザー直接実装、commit 1adfd1b)。Issue #70 close |
| Claude | #18 | ローカル開発環境 docker-compose | ✅ 完了（PR #26 merged） |
| 人間 | #19 | gcloud SDK / Terraform インストール | ✅ 完了 |
| 人間 | #20 | GCP プロジェクト `signage-v2-prod` 作成 | ✅ 完了 |
| 人間 | #21 | 県教委 Wi-Fi フィルタ方式問合せ | ✅ 完了（ドメインベース） |
| 人間 | #22 | ペネトレ業者3社見積依頼 | ❌ **実施しない判断（要再検討）** |

---

## 次にやるべき（次セッション entry point）

> **2026-05-29 サイクル末状態 (更新)**: **#59 DDL Part C2 完走 → F01-F12 解禁**。ただし RLS テストは CI 上 DATABASE_URL 未設定で全 skip 状態のため、実 DB 検証は CI に postgres service container 追加後に初めて意味を持つ。並行ユーザーが PR #90 (WIF) / #91 (observability) / #92 (apps/web Next.js scaffold) を着地済、F01-F12 着手の環境はおおむね整った。

1. **CI に postgres service container 追加 (新規 Issue 起票推奨、最優先)**:
   - `.github/workflows/ci.yml` の test job に `postgres:16` service 追加 + `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kimiterrace_test` 設定
   - **重要**: `turbo.json` の `passThroughEnv` に `DATABASE_URL` + `KIMITERRACE_TEST_DB_OK` を追加しないと turbo がフィルタして vitest に渡らない (PR #93 Reviewer 指摘 High 7)
   - 初回適用で RLS テスト 24 件が実走し、本サイクルで #96 fix 済の Critical 1-3 + High 1-2 が緑になることを確認
2. **PR #93 Reviewer の残指摘を別 Issue 起票 (#96 で扱わなかった分)**:
   - **High 4**: schools に `tenant_isolation` FOR ALL policy 追加 (silent 0-row UPDATE 回避)
   - **High 5**: `audit_log_insert` WITH CHECK に `actor_user_id` 詐称防止 (NFR04 Repudiation)
   - Medium 8-12 / Low 13-15: 順次 (advisory lock hash 衝突、jsonb canonical 化、credential ログ漏出など)
3. **F01-F12 着手** (gate 解禁、CI 化 + High 4-5 修正と並行可):
   - 優先順は F01 (教員ファイル抽出) / F03 (Gemini 構造化) / F04 (即公開 + 安全網) あたりから
4. **#73 (composite FK で cross-tenant 整合 DB 強制)**: 本 PR で RLS 完備したので着手可能
5. **#75 AI/RAG schema M-1〜M-4 bundle** (status enum / raw_input_hash 整合 / composite index / class_id index)
6. **Reviewer worktree バグ (#67)**: 解決方針 C (テンプレ禁止 + worktree 化) を実装
7. **memory 候補 (本サイクル学び)**:
   - 並行ユーザーセッション前提では Desktop の `git checkout` 頻度を最小化、untracked file 中心の操作にする
   - Worker hang 時の Desktop Worker mode 引継ルート (SendMessage tool 不在前提)
   - Reviewer Agent の `gh pr review` 投稿スキップ問題 (PR #71 / #93 で再発、Reviewer brief Step 4-A を最重要マイルストーンとして再強調しても 1/3 失敗率)
6. **Mac mini 復活**:
   - ユーザーが Mac 起動 + Terminal.app から `tmux new -s workers` → Desktop が `config.json` の `mac-mini.enabled` を `true` に戻す
   - SSH 解決 fallback 試行: `Kaitos-Mac-mini.local` (LAN) or Tailscale IP
7. **Reviewer brief template の改善** (本サイクルで発覚):
   - Reviewer Agent #71 が `gh pr review` 投稿スキップして分析返却のみで完了。Desktop が代理投稿で迂回。template の Step 4/5/6 (`gh pr review` 実行 + 標準フォーマット出力) を **失敗時警告付きで強調**する改稿候補
8. **解決すべき orchestrator バグ**:
   - 2 連続 spawn の 2 番目が hang（SSH 多重化由来の疑い）→ `Start-RemoteWorker` 内で SSH 接続を独立化する PR を別途
   - ✅ **修正済 (2026-05-29)**: `lib/state.ps1` の `[int]$Pid` param が PowerShell automatic variable `$PID` と衝突して spawn 起動不可 → `$ProcessId` にリネーム

## 詰まり / 確認待ち

- ✅ **解消 (2026-05-29)**: claude CLI 401 → ユーザーが別ターミナルで claude 起動して OAuth refresh、`~/.claude/.credentials.json` 更新で復旧。次回以降、credentials.json の `LastWriteTime` が 30 日以上古かったら再 refresh が必要になる可能性
- **Mac mini SSH 到達不可** (`ssh: Could not resolve hostname kaitos-mac-mini`): Tailscale / 電源 / tmux 儀式の確認待ち
- **worker-launcher.sh の prNumber 抽出バグ**: macOS BSD `grep -P` 非対応で state.prNumber が常に null（既知、後続課題）
- **Reviewer が Desktop cwd の branch を奪う** (#67): 当面の運用回避策は「Reviewer 走行中に Desktop は git 操作しない、完了後に main へ戻す」

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
- **2026-05-29 (続)**: **PR #66 + #68 連続 merge サイクル (Desktop Worker mode 初投入)**。OAuth refresh で 401 解消 → Reviewer #66 (COMMENT, Critical 0, High 2) → PR #66 admin merge (commit 5872223) → 並列で Desktop が Worker mode で Issue #60 を直接実装 (worktree 隔離、578 行 4 ファイル) → PR #68 → Reviewer #68 (APPROVE, Critical 0, High 0) → PR #68 merge (commit c28e488)。**親 Issue #16 完結** (Part A/B/C 全揃)。Follow-up Issue #67 (Reviewer worktree バグ) / #69 (Terraform root .tf 整理) / #70 (cloud_sql deletion_protection 変数化) 起票。次は DDL Part B/C1/C2 (Worker spawn, setup-heavy $8) + STRIDE Part C (Desktop Worker mode 候補, prose)。
- **2026-05-29 (続々)**: **PR #71 DDL Part B + PR #72 STRIDE Part C 並列 merge (Desktop Worker mode 2 並列パターン確立)**。Worker spawn は RAM 3.7GB で 0 slot 判定 → Agent + worktree isolation で 2 task を並列実行。**PR #71** (167 行、AI/RAG 3 テーブル、CI 11/11 green、Reviewer COMMENT Critical 0 / High 2) + **PR #72** (253 行、STRIDE Part C 10 件、CI 11/11 green、Reviewer 実質 APPROVE Critical 0 / High 0) を同時 squash merge (commits 25bdc68, 64be2b1)。**親 Issue #17 自動 close** (STRIDE 6 カテゴリ全件 3 件以上、合計 29 件)。Follow-up Issue #73 (composite FK cross-tenant 強制) / #74 (pgvector hoist) / #75 (M-1〜M-4 bundle) 起票。Reviewer #71 が `gh pr review` 投稿スキップ問題発覚 → template 改稿候補。次サイクル: DDL Part C1 (#58) → DDL Part C2 (#59 = F01-F12 解禁) → F01-F12 着手。
- **2026-05-29 (続々々)**: **Desktop 重複 spawn 反省サイクル**。前 conversation 末で PR #76 (#74) / #77 (#58) / #80 (#70) が cometa-kaito によって 01:05〜01:06 UTC に作成 → merge 済だったが、本 conversation 開始時 Desktop は **`gh pr list` を実行せず Issue 一覧のみで判断**して #58 / #70 / #74 を再選定 → 3 Worker (Agent + worktree isolation) を並列 spawn → 全部重複 PR (#79 / #81 / #82) を生成。3 PR は close + `worker/*` 3 branch 削除 + worktree cleanup で原状回復。**教訓**: 並行作業しているユーザー前提で動く必要があり、`gh pr list --state=all --search="<issue-num>"` を Worker spawn 前ルーチンに組み込む。新規 memory [[orchestrator-pr-dedup-check]] 追加、MEMORY.md 索引更新。本サイクルの net 成果は教訓のみ、新規 PR 着地なし。
