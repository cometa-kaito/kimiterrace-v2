# 依存アップグレード（dependabot）運用手順

dependabot の bump PR を**安全に**取り込む手順。サプライチェーン・ポリシー、共有チョークポイント、
並行セッションの現実を踏まえる。1 件ずつ naive に merge すると CI チェーンを焼く / セキュリティ制御を
誤って回避する / 並行作業を壊す、のいずれかを踏むため本手順に従う。

関連規律: CLAUDE.md ルール5（Secret/サプライチェーン）・ルール7（テスト緑で進む）、
[ADR-010](../adr/010-pnpm-turborepo.md)（pnpm + Turborepo）、[ADR-011](../adr/011-biome.md)（Biome）。

## 1. 前提（誰が・いつ）

- Desktop Claude（orchestrator）または依存 backlog を拾うセッション。
- `dependencies` / `security` ラベルの open PR、または GitHub の脆弱性アラートを消化するとき。
- **並行セッションが apps/web・packages を活発に編集している間は、チョークポイント依存（§5）に手を出さない。**

## 2. 必要な権限

- リポジトリへの push / PR 作成・merge（Desktop は自律 merge 権限あり）。
- ローカルに pnpm 11 + Node 22（`package.json` の `engines` / `packageManager` に一致）。

## 3. リスク仕分け — dependabot PR の CI rollup をシグナルに

各 dependabot PR の CI を `gh pr view <n> --json statusCheckRollup` で見る。**全 green = その新バージョンで
パイプライン（Build/Type Check/Test/E2E/CodeQL/SAST/Secret Scan）が通過した強い互換シグナル**。
特定ジョブの失敗は原因と対応がほぼ一対一に決まる:

| 失敗ジョブ | 典型原因 | 対応 |
|---|---|---|
| **Setup**（`pnpm install --frozen-lockfile`）が `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | 対象 package が**公開後 ~24h 未満**で supply-chain ポリシーに弾かれた（§4） | **待つ**。override しない |
| **Lint & Format** | Biome のメジャー更新で新ルールがコードを flag（例: 1.x→2.x） | `biome migrate` + 新規指摘の解消が要る（§5、quiet period 向き） |
| **Type Check** | TypeScript / 型に影響する SDK のメジャー更新で型エラー（例: ai SDK 4→5） | コード移行が要る。単独で慎重に |
| 全 green | 互換 | 取り込み候補（§6 で現 main 再検証のうえ merge） |

**注**: dependabot の CI は **PR 作成時の（古い）base** 上で走る。green でも現在の main を保証しないため、
取り込み時は必ず現 `origin/main` 上で再構成・再検証する（§6）。

## 4. サプライチェーン・ポリシー（minimumReleaseAge）は override しない

CI の `pnpm install` は **公開後一定時間（~24h）未満の package を拒否**する `minimumReleaseAge` ポリシーを
有効化している。compromised package を即時に引き込む供給網攻撃への防御。

- `Setup` ジョブが `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` で落ちるのは**セキュリティ制御が正しく
  機能している証拠**。当日公開の最新 patch を載せた dependabot PR で発生する。
- **熟成するまで待つ**（dependabot が後日 rebase する／cutoff を超えれば自然に通る）。
- ポリシーを緩めて新しすぎる package を入れるのは**ルール5・セキュリティ最優先方針に反する。やらない。**

## 5. チョークポイント依存は quiet period に

複数セッションが `apps/web`・`packages` を活発編集している最中に bump すると、in-flight コードや
開発フローを壊す依存:

- **Biome**: 全ファイルの lint/format に効く。`linter.rules.recommended:true` はメジャー更新で新ルールを
  引き込みコード全体を flag しうる。`biome migrate` で config を移行しても新ルール由来の修正が**多数の
  ファイルに散る**＝並行レーンと大量衝突。
- **lint-staged / husky 系**: pre-commit / commit-msg hook の挙動を変える。全セッションの commit フローに影響。
- **対応**: 並行が静かなタイミングで**単独 PR**として、`biome migrate` → `biome ci .` で影響を**実測**してから
  land。0–数ファイルの config 変更で収まるなら可、ソース全体に format/lint 修正が散るなら quiet period まで待つ。

## 6. 手順（コピペ）

並行セッションと衝突しないよう**隔離 worktree**で行う（[parallel-lanes](../parallel-lanes.md)）。
複数の重複ファイル PR（GitHub Actions の同一 step ブロックを編集する `checkout`/`setup-node`/`pnpm`、
連動する `@commitlint/cli`+`config-conventional`）は **1 ブランチに統合**して rebase 連鎖を避ける。

```bash
# 0) 現 origin/main から隔離 worktree（ASCII パス）
git fetch origin main
git worktree add -b chore/bump-<name> /c/Users/<you>/kt-wt/<name> origin/main

# 1) specifier を bump（package.json を編集）。GitHub Actions は .github/workflows のみ（lockfile 不変）
#    npm 依存は対象の全 package.json を ^X.Y.Z に揃える

# 2) lockfile 再生成（npm 依存のみ。--frozen-lockfile は付けない）
pnpm -C <worktree> install

# 3) 現 main コードで再検証（dependabot の古い base CI を信用しない）
pnpm -C <worktree> typecheck        # TS / 型影響 SDK
pnpm -C <worktree> build            # 必要なら
#    CI が実行しない経路は手で実証する:
#    commitlint は hook と同じ呼び出しで有効/無効メッセージの exit 0/1 を両方確認
printf '%s\n' 'feat(web): テスト' > /tmp/m && pnpm -C <worktree> exec commitlint --edit /tmp/m

# 4) commit（hook 経由）→ push → PR。body に "Closes #<dependabot-pr>" で自動 close
git -C <worktree> commit -m "chore(deps): ..."
git -C <worktree> push -u origin chore/bump-<name>
gh pr create --base main --head chore/bump-<name> --title "..." --body-file <body>

# 5) CI 完了待ち（gh pr checks の exit code が確実 / §7）→ merge → worktree 掃除
gh pr merge <pr> --squash --admin
git worktree remove <worktree> --force && git branch -D chore/bump-<name> && git push origin --delete chore/bump-<name>
```

## 7. 検証

- **CI 待ちは `gh pr checks <pr>` の exit code**: `0`=全 pass / `8`=pending / `1`=fail。
  ```bash
  for i in $(seq 1 40); do gh pr checks <pr> >/tmp/c.txt 2>&1; [ $? -ne 8 ] && break; sleep 20; done; cat /tmp/c.txt
  ```
  GUI の bucket を jq で判定する方式は `skipping`（WIF 等）で誤判定・タイムアウトしやすい。
- merge 前に `git fetch && git diff <base>..origin/main -- package.json pnpm-lock.yaml` で
  並行 lockfile 変更（＝衝突）を再検知する。
- merge 後、dependabot が元 PR を up-to-date として自動 close することを確認。

## 8. 失敗時の対処

- **`minimumReleaseAge` 違反**: §4。待つ。override 禁止。
- **Biome / lint-staged の影響が広い**: §5。quiet period まで defer。
- **lockfile が conflict / 並行で同種 bump が先行**: no-op を rebase せず、PR を close + worktree 掃除
  （重複作業の回収。[parallel-lanes](../parallel-lanes.md)）。
- **PowerShell で `git push` 等が `NativeCommandError` に化ける**: git の `remote:` 進捗が stderr に出るだけ。
  **exit 0 なら成功**。出力でなく exit code で判定する。

## 9. 現在の deferred backlog（2026-05-31 時点）

| dependabot PR | 状態 | 理由 |
|---|---|---|
| `@biomejs/biome` 1.9→2.4 (#8) | **defer（quiet period）** | Lint & Format 失敗。2.x 新ルールがコード全体を flag、§5 のチョークポイント |
| `lint-staged` 15→17 (#6) | **待ち** | §4 minimumReleaseAge で当日公開 patch が拒否。熟成後に再試行 |
| `ai` SDK 4→5 (#153) | **defer（要移行）** | Type Check 失敗。`packages/ai` のコード移行が要、AI レーン（F03）と競合域 |

取り込み済みの実例: GitHub Actions 一括 (#255)、TypeScript 6 (#259)、commitlint 21 (#261)。

## 10. 関連

- [parallel-lanes.md](../parallel-lanes.md) — 並行レーン・チョークポイント・worktree 隔離
- [github-actions-auth.md](./github-actions-auth.md) — CI 認証（WIF）
- [db-migrations.md](./db-migrations.md) — マイグレーション適用
- CLAUDE.md ルール5（サプライチェーン）・ルール7（CI 緑）
- [pnpm-workspace.yaml](../../pnpm-workspace.yaml) — `overrides`（脆弱性 pin）・`allowBuilds`
