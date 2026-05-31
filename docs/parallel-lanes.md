# 並行開発レーン設計（Parallel Development Lanes）

> 複数の Claude セッション / Worker / 人間が **同時に開発しても衝突しない**ための分割規律。
> 新セッションは `CLAUDE.md` → `STATUS.md` を読んだ後、**並行作業に入る前に**これを読む。
> 最終更新: 2026-05-31（初版）

---

## 0. TL;DR（30 秒で入れる）

1. **着手前に GitHub でレーンを claim する**（issue を自分に assign + `lane:<name>` ラベル）。`gh pr list --state=all` + `git worktree list` で重複検知（[[orchestrator-pr-dedup-check]]）。
2. **`origin/main` から専用 worktree を切る**（`kt-wt/<lane>-<issue>`、ASCII パス、既存ブランチに stack しない）。
3. **自分のレーンが所有するパスの外を触らない**。共有 chokepoint（`packages/db/**`・lockfile 等）は**トークンを持つレーンだけ**が触る。
4. **land したら worktree とブランチを消す**（堆積の根治）。
5. **live な「誰が何を」は GitHub が唯一の真実**。`STATUS.md` のヘッダや表を上書きして調整しない。

不変条件はこれ一つ → **2 つのレーンが同じファイルを同時に編集しない**。これさえ守れば衝突は起きない。

---

## 1. なぜレーンが要るか（解決したい実問題）

並行開発はすでに走っている（本書執筆時点で稼働 PR #239/#238/#232 + dependabot 滞留、`.claude/worktrees/` 60+ 本 + 手動 `kt-wt/*` 6 本）。そこで繰り返し起きてきた事故は、**機能コードではなく「共有された書き換え可能な一点（chokepoint）」に集中**している：

| 事故 | 起きた場所 | 一次記録 |
|---|---|---|
| migration 採番衝突（0008 が二重）→ リナンバ救済 | `packages/db/{drizzle,migrations}/000N_*.sql` | STATUS 2026-05-31 #214/#206 |
| loader 配列の衝突・「両採用」マージ | `packages/db/__tests__/_setup/global-setup.ts` | [[migration-loader-pattern]] |
| barrel export 衝突（#154 vs #227） | `packages/db/.../index.ts`・`_shared/enums.ts` | STATUS 2026-05-31 #227 |
| STATUS ヘッダの上書きレース | `docs/STATUS.md` 先頭行 | STATUS header 注記 |
| branch hijack で未コミット作業消失 | 共有 working dir の `git add -A` | [[shared-working-tree-collision]]・[[concurrent-git-worktree-isolation]] |
| stacked PR が base squash 後に conflict | 既存 feature ブランチ上の積み増し | [[pr-branch-from-origin-main]] |
| worktree 堆積（ripgrep が timeout する規模） | `.claude/worktrees/`・`kt-wt/*` | 本書 §7 |

**結論**: レーンは「機能を割り振る箱」ではなく、**ファイル所有境界を引いて chokepoint を直列化する仕組み**。

---

## 2. レーンの定義

- **レーン = 排他的なファイル所有境界を持つ作業ストリーム**。
- **1 レーン = 1 worktree = 1 PR ストリーム**（同時 1 PR が原則。連続スライスは land→次で回す）。
- レーンには **owner**（その時間にそのパス群を編集してよい唯一のセッション）がいる。
- owner は GitHub の issue assignee + `lane:<name>` ラベルで表現する（ファイルに書かない＝レースしない）。

---

## 3. レーン種別と所有マップ

| レーン | 所有パス（編集してよいのはこのレーンだけ） | 並列性 | トークン |
|---|---|---|---|
| **feature レーン（縦）** | `apps/web/lib/<feature>/`・`apps/web/app/<route>/`・対応する `__tests__`。例: `lane:signage` `lane:editor` `lane:system-admin` `lane:ai-extraction` | **完全並列**（feature 同士は衝突しない） | 不要 |
| **DB/schema レーン（共有・直列）** | `packages/db/**`（schema・`drizzle/`・`migrations/`・`global-setup.ts`・`_shared/enums.ts`） | **同時 1 本**（schema トークン保持者のみ） | **schema-token** |
| **infra レーン** | `infrastructure/**`（Terraform） | 直列（tf state） | infra-token |
| **deps レーン** | `pnpm-workspace.yaml`・`pnpm-lock.yaml`・dependabot PR・`package.json` の deps | 同時 1 本（lockfile が一点） | deps-token |
| **docs/meta レーン** | `docs/`・`docs/adr/`・`CLAUDE.md` | append 主体・低衝突（例外: `STATUS.md` は §7） | 不要 |

### 3.1 feature レーンが schema 変更を要するとき

feature レーンは `packages/db/**` を**触れない**。テーブル追加・列追加・RLS・migration が必要なら、次のどちらか：

- **(A) 推奨**: 先に DB/schema レーンでスキーマを land させ、feature レーンはそれを `import` して使う（read 層・型は `InferSelectModel` 派生 = ルール3）。スライスを「schema → 機能」の 2 段に分ける。
- **(B)** feature レーンが一時的に schema-token を取得して `packages/db/**` も含めて 1 PR にする（≤500 行ならアリ。token 中は他レーンが schema を触らない）。

---

## 4. 共有 chokepoint と規律

| chokepoint | なぜ衝突するか | 規律（暫定 / 目標） |
|---|---|---|
| migration 番号（`drizzle/000N` + `migrations/000N` の **2 系列**、現在ともに 0010） | 連番名前空間。2 レーンが同番号を取る | **暫定**: schema-token 保持の 1 レーンのみ採番。**目標**: timestamp 採番（§10 follow-up）で衝突を構造的に不能化 |
| `global-setup.ts` の loader | 新 migration ごとに「const 宣言 + 依存順への挿入」が必須＝必ず同ファイルを編集 | **暫定**: DB レーン専有。**目標**: ディレクトリ自動 discovery + ファイル名順実行（§10） |
| `index.ts` barrel / `_shared/enums.ts` | re-export を複数レーンが追記 | **追記のみ・並べ替え/削除禁止**。enum 追加は DB レーン専有（[[drizzle-enum-export]]: re-export 漏れは破壊的 DROP TYPE を誘発） |
| `STATUS.md` 先頭ヘッダ | 全セッションが「最終更新」行を commit 順で上書き | **ヘッダ上書きで調整しない**。live 状態は GitHub（§7）。STATUS は履歴 append のみ |
| `pnpm-lock.yaml` / `pnpm-workspace.yaml` | 依存変更が一点に集まる | **deps レーン専有**。feature レーンは安易に依存追加しない（pin/override は `pnpm-workspace.yaml`＝[[pnpm11-overrides-location]]） |

> push 前に必ず `biome check --write` → `biome ci`（import 順は CI だけが落とす＝[[biome-ci-before-push]]）、typecheck は `tsc; echo EXIT=$?` で**実コマンドの exit code**を確認（[[verify-exit-code-not-tail]]）。

---

## 5. レーン ライフサイクル（claim → isolate → work → land → release）

```bash
# 1) CLAIM — GitHub 上で所有を宣言（ファイルに書かない＝レースしない）
gh pr list --state=all --limit 50      # 重複 PR 検知（[[orchestrator-pr-dedup-check]]）
git worktree list                      # 既存 worktree と重複検知
gh issue edit <N> --add-label "lane:<name>" --add-assignee @me

# 2) ISOLATE — origin/main から直接 worktree（stack しない＝[[pr-branch-from-origin-main]]）
git fetch origin
git worktree add -b feat/<issue>-<slug> ../kt-wt/<lane>-<issue> origin/main
#   ↑ ASCII パス。日本語 working dir は worktree 隔離で避ける（[[parallel-session-worktree-recovery]]）

# 3) WORK — 所有パス内のみ編集。chokepoint はトークン保持時のみ。選択 add で commit
git -C ../kt-wt/<lane>-<issue> add <自分のパスのみ>   # git add -A は branch hijack の元

# 4) LAND — Reviewer Agent を別 spawn（self-review 不可・客観性）→ CI green → 自律 merge
#    （busy-CEO mode: Reviewer APPROVE + CI green なら許可不要で squash merge）

# 5) RELEASE — 後始末（堆積の根治）
git worktree remove ../kt-wt/<lane>-<issue>
git branch -d feat/<issue>-<slug>
```

- **共有 working dir（メインチェックアウト）で git 操作しない**。着手前に必ず `git branch --show-current` + `git status` で想定状態と一致を確認（[[shared-working-tree-collision]]）。
- 停滞した他レーンの worktree は**破壊せず** cherry-pick で救出（[[parallel-worktree-commit-recovery]]）。相手ブランチを reset しない。

---

## 6. 「進めて」だけで回る自律フロー（衝突回避 × context 経済）

ユーザーが「進めて」「続けて」とだけ言ったら、Desktop は聞き返さず（[[proceed-without-asking]]）次の手順で **1 レーンを最後まで回す**。狙いは ①他レーンと衝突しない ②Desktop の context を枯らさない の両立。

### 選定（cheap discovery — `STATUS.md` 全文を読まない）

GitHub の構造化クエリだけで次レーンを決める。542 行の `STATUS.md` 履歴を context に読み込まない（浪費）。

```bash
gh pr list  --state=all  --limit 50 --json number,title,headRefName,statusCheckRollup
gh issue list --state open --json number,title,labels,assignees
git worktree list
```

- **in-flight のレーンが所有するパスと重ならない** feature レーンを 1 つ選ぶ。
- schema / deps / infra **トークンが他レーンに握られていれば、それを要するタスクは選ばない**（待たずに別の独立レーンへ）。
- 重複 PR / 停滞 worktree を検知（[[orchestrator-pr-dedup-check]]）。

### 実行（context を温存する分担）

| タスク規模 | 担当（busy-CEO 判断マトリクス） |
|---|---|
| 1 ファイル〜数百行・設計と実装が一体 | **Desktop 直接**（worktree 隔離で） |
| 1000+ 行・setup-heavy・長時間ブロック可能性 | **Worker spawn**（worktree isolation で Desktop context 温存） |
| レビュー | **Reviewer Agent spawn**（必須・self-review 不可） |

- PR diff 全文を context に読まない。`--json` メタ + `file:line` 参照。
- Worker / Reviewer の log は **異常時のみ** `tail -30`。
- land（Reviewer APPROVE + CI green → 自律 squash merge）→ **worktree 解放** → 次レーンへ連続。

→ これで「進めて」の 1 語が、衝突しない並列スライスを **context 一定**で回し続ける。

---

## 7. live coordination ledger（race-free）

**唯一の真実 = GitHub**。理由: 複数セッションが同時に書いてもレースしない（issue/label/assignee/PR はサーバ側で直列化される）。

| 知りたいこと | 見る場所 |
|---|---|
| いま誰がどのレーンを持っているか | open issue の `lane:<name>` ラベル + assignee |
| いま何が in-flight か | `gh pr list --state=open` |
| schema/deps トークンを誰が握っているか | `packages/db/**` or lockfile を触る open PR（同時 1 本のはず） |

- **`STATUS.md` の「今やっているもの」live 表は廃止**（陳腐化 + ヘッダ上書きレースの温床）。`STATUS.md` は **append-only の履歴と次アクションのポインタ**に役割を限定する。
- 各 PR の一次記録は **PR body**（STATUS ヘッダは上書きされる前提）。

---

## 8. WIP 上限と粒度

- **同時 feature レーン数** ≤ orchestrator の worker cap（`scripts/orchestrator/config.json`: local 3 worker / 2 reviewer）。Agent spawn 並列はこれを目安にする。
- **schema / deps / infra トークンは各 1 本**（直列）。feature レーンは何本でも、ただし所有パスが重ならないこと。
- **1 レーン = 1 mergeable スライス ≤500 行**（ルール6）。超えそうなら縦に割る。

---

## 9. 8 ルール / busy-CEO mode との関係

- レーンは busy-CEO 判断マトリクスの「**並列度 N で稼げる独立タスク → Worker / Agent spawn 並列**」を、**衝突しない形に具体化**したもの。
- **Reviewer 必須は不変**（[[worker-review-discipline]]）。レーンを分けても self-review はしない。
- 8 ルール（監査カラム / RLS / 型単一ソース / PII マスキング / Secret Manager / ≤500 行 / テスト緑 / Terraform 化）はレーン内で従来どおり適用。レーンはそれらを**緩めない**。

---

## 10. follow-up レーン（構造改修・要 GO）

本書は**運用規律の確立まで**（コードは無変更＝稼働中 session に衝突面ゼロ）。以下は `packages/db/**` 等のホットゾーンを触るため、別レーン化して稼働中セッションと調整した上で着手する：

1. **migration の timestamp 採番 + loader 自動 discovery**（chokepoint を規律ではなく構造で消す）。`packages/db/{drizzle,migrations}` を触るため schema-token 必須。
2. **worktree GC**: `git worktree prune` + merged ブランチの worktree 削除。**注意**: `.claude/worktrees/agent-*` は Agent ツール管理（自動掃除されうる・locked）なので手動削除しない。掃除対象は手動の `kt-wt/*`・`kimi-wt-*` のうち **merged 済み**のものに限定。
3. **`lane:*` ラベル体系の整備** + `STATUS.md` の live 表撤去（§7 の GitHub 委譲を実体化）。
4. **orchestrator bug fix / Mac mini 再活性化**（2 連続 spawn hang、`scripts/orchestrator/`）。大量並列が必要になってから。

---

## 関連

- 規律インデックス: [CLAUDE.md](../CLAUDE.md)（Operating Mode = busy CEO）
- 現在地: [STATUS.md](STATUS.md)
- spawn orchestrator: [scripts/orchestrator/README.md](../scripts/orchestrator/README.md)
- memory: [[busy-ceo-mode]] [[proceed-without-asking]] [[concurrent-git-worktree-isolation]] [[pr-branch-from-origin-main]] [[shared-working-tree-collision]] [[orchestrator-pr-dedup-check]] [[migration-loader-pattern]] [[parallel-worktree-commit-recovery]]
