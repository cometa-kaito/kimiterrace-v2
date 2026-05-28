# Orchestrator パイプラインパターン

Desktop Claude を **idle にしない** ための作業フロー設計。Reviewer や Worker の完了を待っている間に並列で別の独立作業を spawn する。

## 前提

- 誰が: Desktop Claude（Orchestrator）
- いつ: 「進めて」「再開して」「どう？」などで Desktop が Worker/Reviewer を spawn したサイクル中
- 目的: Mac Mini Worker の **並列性** を最大化し、Reviewer 完了待ちで Desktop が止まらないようにする

## 必要な権限

- Mac Mini への SSH key (`~/.ssh/id_kimiterrace`)
- gh CLI（admin 権限の cometa-kaito）
- `scripts/orchestrator/orchestrator.ps1` の実行

## 設計原則

### Tier 分類で issue を分けてから spawn

**Tier 0（完全独立）**: 新規ファイル / 別ディレクトリの作業。今 main にあるものだけで動く。**即 spawn 可**。

例:
- `docs/architecture/sequence-diagrams/*.md` を新規追加（既存ファイルへの追記でない）
- `infrastructure/terraform/` の雛形
- `docs/runbooks/` の新規 runbook（Desktop 自身が書く場合）
- `apps/firmware/` の最初期実装

**Tier 1（merged main 依存）**: 既に main に着地したコード / docs を参照する作業。**即 spawn 可**。

例:
- Part A が main に merge 済の状態で、A の schema を使う Worker (typecheck で `_shared/audit.ts` を参照する場合)
- すでに着地した sequence 図に対する E2E テスト

**Tier 2（未 merge PR 依存）**: 走行中の Reviewer が判定する PR 内容に依存する作業。**待機**。

例:
- 同一ファイルへの追記（`docs/architecture/threat-model.md` のように Part A/B/C で同じファイルを更新するもの）
- Part A PR が merge されるまでの Part B DDL（`_shared/audit.ts` を参照したいが main にまだない）

### サイクル中の動き

```
[t=0]      Worker 完了 → PR 作成通知
[t=0+5s]   Desktop:
           - PR が依存ツリーで何を unblock するか判定
           - Reviewer を即 spawn（PR ごとに solo）
           - **同時に** 次の Tier 0/1 Worker を spawn
[t=2-5m]   Reviewer 完走、PR comment 投稿
[t=5m+10s] Desktop:
           - APPROVE 相当 + CI green → merge
           - REQUEST_CHANGES → fix-up Worker spawn（既存 branch patch / 新 issue）
           - merge により unblock した Tier 2 issue があれば即 spawn
```

### Desktop の context 経済性は維持

- Reviewer の log は **read しない**（PR comment だけ参照）
- Worker の log は **read しない**（最後の `WORKER COMPLETE` + cost / `pull/N` 抽出のみ）
- 走行中の workers tmux は **list-windows でカウントだけ確認**、attach しない

## 手順

### 1. spawn 前の Tier 判定

```bash
# 待機中の issue 一覧
gh issue list --label claude-task --state open --json number,title

# 各 issue について:
# - 触るファイルが 既存 (main) or 走行中 PR or まだ無い
# - 走行中 PR と同じファイル → Tier 2、待機
# - main にあるファイルだけ → Tier 1、即 spawn
# - 完全新規ディレクトリ → Tier 0、即 spawn
```

### 2. solo spawn pattern

並列 issue を **1 invocation で複数指定すると 2 番目が hang** する既知症状を避けるため、各 spawn を **別 PowerShell 起動** で:

```powershell
# OK: 3 つ別々のバックグラウンド起動
Start-Job { .\scripts\orchestrator\orchestrator.ps1 spawn -Issues 60 }
Start-Job { .\scripts\orchestrator\orchestrator.ps1 spawn -Issues 65 }
Start-Job { .\scripts\orchestrator\orchestrator.ps1 spawn -Issues 67 }

# NG: 1 invocation で多重指定（2 番目が hang）
.\scripts\orchestrator\orchestrator.ps1 spawn -Issues 60,65,67
```

Claude Code セッション内では `Bash` / `PowerShell` の `run_in_background: true` で個別 invocation。

### 3. spawn 後の確認

- 各 spawn の `Spawned.Id` を記録（`worker-YYYYMMDDTHHMMSS-issue-N`）
- ssh で `tmux list-windows -t workers` → 期待数の window が出現すれば OK
- 出現しない場合は phantom（state JSON のみで launcher 未起動）→ state を `.phantom` リネーム + 単独再 spawn

### 4. Reviewer auto-pipeline

Worker 完了 → PR 作成 → Reviewer spawn は **同一 cycle 内で連続** 実行する。Desktop は:

```
gh pr list --search "head:feat/N-orchestrated" --json number   # PR 番号取得
.\scripts\orchestrator\orchestrator.ps1 spawn -Issues <PR#> -Role reviewer
```

### 5. Tier 2 unblock のトリガ

PR merge ごとに `git fetch origin && gh pr list` で未merge を確認、unblock した Tier 2 issue を Tier 1 に格上げして即 spawn。

## 検証

このパターンが効いているかの指標:

- 1 Reviewer サイクル中に **0 Desktop idle time**（常に何か spawn 中 or merge 中 or issue 作成中）
- Mac Mini の workers tmux に **常に 1 以上の active window**（reviewer/worker 計）
- Desktop context は サイクルあたり **~6,000 tokens 目標**を維持

## 失敗時の対処

| 症状 | 対処 |
|---|---|
| 2 連続 spawn の 2 番目が hang | `Stop-Process` で hung ssh を kill、state JSON を `.phantom` リネーム、solo で再 spawn |
| Reviewer が worker brief を読んでしまう | `scripts/orchestrator/orchestrator.ps1` の `Render-WorkerBrief` で role 別 template 選択を確認（2026-05-28 修正済） |
| Worker が $5 / $8 budget 枯渇 | task type 確認: prose=$5 / DDL/scaffold=$8（[[worker-budget-by-task-type]]）。さらに枯渇するなら親 issue を sub に再分割 |
| PR が merge 不可（head out of date） | `gh pr merge --admin` で bypass（Desktop admin 権限有り、[[pr-merge-authority]]） |

## 関連

- [[kimiterrace-orchestrator]] — 体制全体
- [[worker-task-granularity]] — issue 分割の経験則
- [[worker-budget-by-task-type]] — タスク種別ごとの budget
- [[worker-review-discipline]] — Reviewer 必須化のルール
- [[pr-merge-authority]] — Desktop の merge 権限
- `CLAUDE.md` — Orchestrator Mode セクション
- `scripts/orchestrator/README.md` — orchestrator スクリプトの使い方
