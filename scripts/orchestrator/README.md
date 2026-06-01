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

## Multi-Machine (リモート Worker)

Worker を別マシン（Mac Mini / 余り PC / Cloud VM）に分散して、ローカル PC の RAM 圧迫を回避できます。

### アーキテクチャ

```
Windows Desktop (Orchestrator)
  └─ SSH ──→ Mac Mini (Worker 専用機)
                ↓
             claude -p < brief
                ↓
             git push → GitHub
                ↑
Orchestrator が gh pr で完了確認
```

通信は **SSH のみ**。共有ストレージや MQ 不要。

### Mac Mini を Worker として追加する手順

#### 1. Mac 側セットアップ

Mac Mini のターミナルで：

```bash
# リポジトリを clone してセットアップスクリプトを実行
git clone https://github.com/cometa-kaito/kimiterrace-v2.git ~/work/kimiterrace-v2
bash ~/work/kimiterrace-v2/scripts/orchestrator/setup-mac-worker.sh
```

- Xcode CLI / Homebrew / Node 22 / pnpm / gh / claude / jq を idempotent にインストール
- `~/work/kimiterrace-v2/` に repo を配置
- `~/.kimiterrace-orchestrator/{workers,logs}/` を作成

セットアップ後、**対話的に**:

```bash
gh auth login       # GitHub.com / HTTPS / login with browser
claude auth login   # ブラウザで claude.ai サインイン
```

`claude auth login` は同じ claude.ai アカウントで OK（並列制限の懸念は config の `workerHardCap` でコントロール）。

#### ⚠️ Keychain と tmux セッションの重要事項

macOS は `claude` / `gh` の認証情報を **Keychain に保存**します。**SSH 非対話セッションは Keychain にアクセスできない**ため、SSH 経由で直接 `claude` を起動するとログインしていない扱いになります。

回避策: **Mac の Terminal.app から `tmux` セッションを起動**しておき、Orchestrator はそのセッションに `new-window` で job を投入する方式を採ります（`tmux` server は Terminal.app の Keychain 権限を継承）。

セットアップ（**Mac 再起動後に毎回必要**）:

```bash
# Mac の Terminal.app で実行
brew install tmux            # 初回のみ
tmux new -s workers -d       # detached で起動、再起動毎に必要
tmux list-sessions           # 「workers: 1 windows ...」と表示されれば OK
```

自動起動したい場合は LaunchAgent 化（後述）。それまでは Mac 起動直後に上記コマンドを Terminal.app で1回実行してください。

#### 2. SSH 設定（Windows 側）

```powershell
# 鍵生成（passphrase 付き推奨。Windows ssh-agent が unlock 状態を保持）
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\id_kimiterrace -C "kimiterrace"

# ssh-agent 有効化（Windows 起動毎に自動起動、鍵 unlock 1回で永続）
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
ssh-add $env:USERPROFILE\.ssh\id_kimiterrace

# 公開鍵を Mac に登録（Tailscale 名 or LAN 名どちらでも）
type $env:USERPROFILE\.ssh\id_kimiterrace.pub | ssh kaitookumura@kaitos-mac-mini "cat >> ~/.ssh/authorized_keys"

# 動作確認
ssh kaitookumura@kaitos-mac-mini "uname -a"
```

Mac 側でリモートログインを有効化:
- System Settings → 一般 → 共有 → リモートログイン を ON
- 許可するユーザー: 自分のアカウントのみ

⚠️ **Git Bash 経由の SSH は ssh-agent と通信できない**ため、passphrase 付き鍵だと non-interactive で失敗します。Orchestrator は PowerShell から ssh.exe を呼ぶので問題なし。手動テストする時は PowerShell から実行してください。

#### 2.5. Tailscale 経由接続（LAN 外でも Worker 使う場合）

両機が Tailscale で同じ tailnet に入っていれば、**LAN 外でも MagicDNS 名で接続できます**:

```powershell
# Windows / Mac 両方で Tailscale ログイン（同じアカウント）
# Mac の Tailscale.app は Preferences → Run at startup ON 推奨

# 接続確認（自宅外からでも）
tailscale status   # Mac が online であること確認
ssh kaitookumura@kaitos-mac-mini "echo hello"
```

config.json の `host` は **MagicDNS 短縮名**を使うのが推奨:

| host 設定 | 動作範囲 | 備考 |
|---|---|---|
| `kaitos-mac-mini` (MagicDNS) | LAN / 外出先 / VPN いずれでも | **推奨**、Tailscale が経路を自動最適化 |
| `Kaitos-Mac-mini.local` (mDNS) | 同一 LAN のみ | Tailscale 未起動時のフォールバック |
| `100.124.63.27` (Tailscale IP) | LAN / 外出先（Tailscale 必須） | IP は変わりにくいが MagicDNS 名の方が安定 |

LAN 内にいる時、Tailscale は自動で **P2P 直接接続**（DERP 経由しない）するので、性能ペナルティは実質ゼロです。

#### 3. config.json 更新

```json
{
  "machines": {
    "mac-mini": {
      "enabled": true,                              ← false から true に
      "host": "Kaitos-Mac-mini.local",              ← 実際の hostname
      "user": "kaitookumura",                       ← Mac のユーザー名
      "sshKey": "~/.ssh/id_kimiterrace",
      "tmuxSession": "workers",                     ← tmux session 名
      "remoteRepoPath": "/Users/.../kimiterrace-v2" ← 絶対パス推奨
    }
  }
}
```

#### 4. 動作確認

```powershell
# 両マシンが見えるか
powershell scripts/orchestrator/orchestrator.ps1 probe

# 並列度合計
powershell scripts/orchestrator/orchestrator.ps1 plan -Issues 11,14,18
```

### 期待される効果

Apple Silicon Mac Mini (16GB RAM) を追加すると:

| 構成 | local 並列 (Windows) | remote 並列 (Mac) | 合計 |
|---|---|---|---|
| Windows のみ（現在） | 2〜3 | — | 2〜3 |
| **+ Mac 16GB** | 2 (RAM 圧迫解消) | **4〜5** | **6〜7** |

Worker は Mac で動くので **Windows の RAM が圧迫されない**ことが大きい。

### サブスク並列制限

`claude.ai` サブスクは「同時 5 セッション程度」が経験則上の上限です。
Windows + Mac で合計 5 並列を超えると rate limit に当たる可能性があります。

**Claude Max サブスクはより緩い**（厳密な制限値は公開されていないが、Pro より多並列）。
当面はサブスクのまま運用、rate limit に当たり始めたら API key 課金に切替を検討。

### トラブルシュート: workers セッションが見つからない

```
Remote worker spawn failed (is tmux session 'workers' running on ...): ...
can't find session: workers
```

→ Mac で再起動後に `tmux new -s workers -d` を実行し忘れている。Mac Terminal.app で実行してください。

### トラブルシュート: claude が「loggedIn: false」

```
{"loggedIn": false, "authMethod": "none"}
```

→ tmux session が Mac Terminal.app **以外**（例: SSH 経由）から起動されている。Keychain アクセスがない。
Mac の Terminal.app から `tmux kill-session -t workers; tmux new -s workers -d` で再起動。

### 自動起動の設定（LaunchAgent、任意）

毎回手動で `tmux new -s workers -d` を実行するのが面倒なら、launchd User Agent でログイン時自動起動できます。
ただし Keychain ロック解除のタイミング次第では認証アクセスができない場合があり、要検証。当面は手動推奨。

---

## 既知の制約

1. **Windows + Git Bash 前提（Orchestrator 側）**
   - `bash`、`timeout` (coreutils)、`node` が必要
   - 通常 Git for Windows + pnpm 環境に含まれる
   - 注: config / PR 番号のパースは PCRE (`grep -oP`) を**使わない** — BSD grep には `-P` が無く、Git-Bash GNU grep も非 UTF-8 locale で `-P` を拒否するため。クロスプラットフォームな解析は `node` に統一している（5054cef / #386）
2. **`claude.ai` サブスクの並列制限は未測定**
   - 並列 5 以上で rate limit に当たる可能性
   - 必要時は API key 課金へ
3. **`claude agents` サブコマンド（TUI）未対応**
   - Claude Code のネイティブ background agents は対話 TUI のため orchestrator から直接呼べない
   - 将来 SDK API が出たら統合検討
4. **Worker 失敗時の retry なし**
   - Manual に再 spawn 必要
   - 自動 retry は v0.3 で検討
5. **Remote Worker の state file は SSH で取得**
   - 状態確認のたびに SSH 接続が走るので、ネットワーク遅延がそのまま反映される
   - LAN 内なら問題なし、Internet 経由なら数秒の遅延

## 次に追加したい機能 (v0.3+)

- [ ] Worker 完了の自動検出（PR 作成イベントポーリング）
- [ ] Reviewer 自動 spawn（Worker 完了 → Reviewer を即 spawn）
- [ ] 失敗 Worker の自動 retry（1回まで）
- [ ] `claude agents` (TUI) との連携検討
- [ ] Cron からの夜間無人実行（unsafeAutoApprove + 範囲限定）
- [ ] Cloud Run / GitHub Codespaces で Worker を走らせる選択肢
- [ ] 機械間ロードバランス（routing.preferRemote 以外の戦略：min-load 等）
