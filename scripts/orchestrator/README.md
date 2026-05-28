# Orchestrator

Desktop Claude が「進めて」と言われた時に呼ぶ、**並列ワーカー管理スクリプト群**。

## 設計の核

長期12週開発を Claude Code で回すには:

1. **Desktop Claude のコンテキストを枯らさない**
   → Worker は独立 process (`claude -p` 別 invocation) で走らせる
   → 結果は PR/log のみが返る、Worker の実装本文は Desktop に流入しない

2. **マシンリソースに応じた並列度の動的決定**
   → RAM / Disk / CPU をリアルタイム計測
   → 安全に走らせられる Worker 数だけ spawn

3. **失敗・暴走の局所化**
   → Worker ごとに timeout、`--max-budget-usd` で金銭上限
   → 各 Worker は別 worktree（git による物理隔離）

## アーキテクチャ

```
あなた (1 Desktop)
  ↓ 「進めて」
Desktop Claude (Orchestrator Mode)
  ↓ Bash: powershell scripts/orchestrator/orchestrator.ps1 spawn -Issues 11,14,18
PowerShell orchestrator
  ↓ probe (RAM/Disk/CPU) → capacity 計算 → 並列度決定
  ↓ Start-Process bash worker-launcher.sh ...
Bash launcher
  ↓ git worktree add → cd → pnpm install → claude -p < brief
Worker Claude (独立 process)
  ↓ 実装 → テスト → commit → push → gh pr create
PR 作成
  ↑ Orchestrator が gh pr view --json で完了検知
  ↑ Reviewer Claude を spawn
```

## ファイル構成

```
scripts/orchestrator/
├── README.md                       このファイル
├── config.json                     マシン別チューニング値
├── orchestrator.ps1                エントリーポイント
├── worker-launcher.sh              Worker 実行スクリプト（bash）
├── lib/
│   ├── probe.ps1                   リソース計測
│   ├── capacity.ps1                並列度計算
│   └── state.ps1                   Worker 状態管理
└── templates/
    ├── worker-brief.md.template    Worker への指示書
    └── reviewer-brief.md.template  Reviewer への指示書
```

State 保存先: `~/.kimiterrace-orchestrator/` (config.json で変更可)

## 使い方（Desktop Claude 用）

### 1. 状況確認

```powershell
powershell -File scripts/orchestrator/orchestrator.ps1 probe
```

出力例:
```json
{
  "FreeRamMb": 4330,
  "FreeDiskMb": 60300,
  "CpuLoadPct": 22.5,
  "ClaudeProcessCount": 13
}
```

### 2. 並列度の事前計算

```powershell
powershell -File scripts/orchestrator/orchestrator.ps1 plan -Issues 11,14,18
```

`MaxConcurrent` フィールドが「今すぐ何個 spawn できるか」。

### 3. 実 spawn

```powershell
powershell -File scripts/orchestrator/orchestrator.ps1 spawn -Issues 11,14,18
```

容量を超える分は **deferred** として返るので、次サイクルで再 spawn。

### 4. 状態確認

```powershell
powershell -File scripts/orchestrator/orchestrator.ps1 status
```

### 5. クリーンアップ

```powershell
powershell -File scripts/orchestrator/orchestrator.ps1 cleanup
```

merge 済みブランチの worktree を削除、古い state ファイルを掃除。

## 並列度の計算ロジック

`config.json` の値を使って、以下の最小値を取る:

```
ram_slots  = floor((FreeRAM - desktopReserve) / (ramPerWorker × safetyMargin))
disk_slots = floor((FreeDisk - minFreeDisk) / diskPerWorktree)
hard_cap   = workerHardCap

if CpuLoadPct >= cpuLoadMaxPct → 0 (CPU 過負荷時は spawn しない)

available = max(0, min(ram_slots, disk_slots, hard_cap) - 現在 active な worker 数)
```

このマシン (16GB RAM / 60GB free disk) の初期想定:

| 状況 | 並列度 |
|---|---|
| Desktop アイドル、他アプリ閉じてある | 3〜4 |
| Chrome 等が動いている通常状態 | 2 |
| 既に 13 個の claude process が残っている | 0〜1（要 Desktop 再起動）|

## セキュリティモデル

Worker は以下の防御層を持ちます:

1. **`--permission-mode acceptEdits`** がデフォルト（破壊的操作はプロンプトする）
2. **`--allowedTools`** で許可ツールを明示列挙
   - `Bash(git *)`, `Bash(gh *)`, `Bash(pnpm *)`, `Edit`, `Read`, `Glob`, `Grep`, `Agent`, `WebFetch`, `WebSearch`
3. **`--disallowedTools`** で危険コマンドを明示拒否
   - `Bash(rm *)`, `Bash(sudo *)`, `Bash(curl *)`, `Bash(wget *)`, `Bash(npm install -g *)`
4. **`--max-budget-usd`** で予算上限（暴走の最大損失額を制限）
5. **`timeout`** で実時間上限
6. **`unsafeAutoApprove`** をデフォルト `false`（完全自動承認は明示 opt-in 必須）

`unsafeAutoApprove: true` にした場合は `--dangerously-skip-permissions` が有効化されますが、
**夜間無人運用などの覚悟がある時のみ**にしてください。

## Desktop Claude が **やらないこと**（Orchestrator Mode）

CLAUDE.md にも書きますが、Desktop 側の規律:

- ❌ `Edit` / `Write` で実装ファイルを直接編集（orchestrator brief 出力は例外）
- ❌ `git commit` / `git push`
- ❌ `pnpm install` などの環境変更
- ❌ Worker / Reviewer の log / PR diff 全文を context に読み込む
  - PR メタデータ JSON / Reviewer 総合判定のみ
- ❌ PR の `merge` ボタン（人間判断）

Desktop の context を軽く保つことが**長期セッション維持の鍵**です。

## 既知の制約

1. **Windows + Git Bash 前提**
   - `bash`、`timeout` (coreutils)、`grep -oP` (PCRE) が必要
   - 通常 Git for Windows に含まれる
2. **`claude.ai` サブスクの並列制限は未測定**
   - 並列 3 以上で rate limit に当たる可能性
   - 必要時は API key 課金へ
3. **`claude agents` サブコマンド（TUI）未対応**
   - Claude Code のネイティブ background agents は対話 TUI のため orchestrator から直接呼べない
   - 将来 SDK API が出たら統合検討
4. **Worker 失敗時の retry なし**
   - Manual に再 spawn 必要
   - 自動 retry は v0.2 で検討

## 次に追加したい機能 (v0.2+)

- [ ] Worker 完了の自動検出（PR 作成イベントポーリング）
- [ ] Reviewer 自動 spawn（Worker 完了 → Reviewer を即 spawn）
- [ ] 失敗 Worker の自動 retry（1回まで）
- [ ] `claude agents` (TUI) との連携検討
- [ ] Cron からの夜間無人実行（unsafeAutoApprove + 範囲限定）
- [ ] Cloud Run / GitHub Codespaces で Worker を走らせる選択肢
