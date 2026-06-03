#!/usr/bin/env bash
# Mac Worker セットアップスクリプト
#
# Mac Mini で実行することを想定。Apple Silicon (M1+) macOS 13+ 対応。
# 既存環境を尊重し、追加が必要なものだけインストールする（idempotent）。
#
# 使い方:
#   curl -fsSL https://raw.githubusercontent.com/cometa-kaito/kimiterrace-v2/main/scripts/orchestrator/setup-mac-worker.sh | bash
#   または
#   git clone https://github.com/cometa-kaito/kimiterrace-v2.git ~/work/kimiterrace-v2
#   bash ~/work/kimiterrace-v2/scripts/orchestrator/setup-mac-worker.sh

set -euo pipefail

WORK_DIR="${WORK_DIR:-$HOME/work}"
REPO_NAME="kimiterrace-v2"
REPO_URL="https://github.com/cometa-kaito/kimiterrace-v2.git"
NODE_VERSION="22"

log()  { printf "\n\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
err()  { printf "  \033[1;31m✗\033[0m %s\n" "$*"; exit 1; }

# 信頼済みの公式インストーラを「取得 → 実体化 → (任意で SHA-256 検証) → 実行」する。
# ネットワーク取得を直接シェルへパイプする方式は (a) 途中切断で部分実行されうる
# (b) SAST(Semgrep curl-pipe-bash) を恒常 fail させセキュリティゲートを盲目化する (#518)。
# 一旦ファイルへ落としてから実行することで両者を回避する (dev-only の Mac worker setup)。
# 使い方: fetch_and_run <url> <description> [expected_sha256]
fetch_and_run() {
  local url="$1" desc="$2" expected_sha="${3:-}"
  local tmp
  tmp="$(mktemp)" || err "mktemp failed"
  curl -fsSL "$url" -o "$tmp" || { rm -f "$tmp"; err "download failed: $desc ($url)"; }
  [[ -s "$tmp" ]] || { rm -f "$tmp"; err "downloaded installer is empty: $desc"; }
  if [[ -n "$expected_sha" ]]; then
    local actual
    if ! actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"; then
      rm -f "$tmp"
      err "checksum computation failed for $desc"
    fi
    if [[ "$actual" != "$expected_sha" ]]; then
      rm -f "$tmp"
      err "checksum mismatch for $desc: expected $expected_sha, got $actual"
    fi
    ok "checksum verified: $desc"
  fi
  /bin/bash "$tmp" || { rm -f "$tmp"; err "installer failed: $desc"; }
  rm -f "$tmp"
}

# ---------------------------------------------------------------------------
log "1/8  OS check"
OS="$(uname -s)"
[[ "$OS" == "Darwin" ]] || err "macOS only. Detected: $OS"
ok "macOS $(sw_vers -productVersion)"
ARCH="$(uname -m)"
ok "Architecture: $ARCH"

# ---------------------------------------------------------------------------
log "2/8  Xcode Command Line Tools"
if xcode-select -p >/dev/null 2>&1; then
  ok "already installed: $(xcode-select -p)"
else
  warn "installing... (this opens a GUI dialog, click Install)"
  xcode-select --install
  echo
  read -r -p "Press ENTER once the install dialog completes... "
fi

# ---------------------------------------------------------------------------
log "3/8  Homebrew"
if command -v brew >/dev/null 2>&1; then
  ok "already installed: $(brew --version | head -1)"
else
  warn "installing Homebrew..."
  # HEAD = upstream の移動する公式インストーラ。pin 不能ゆえ checksum 検証なし (公式手順踏襲)。
  fetch_and_run "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh" "Homebrew"
  if [[ "$ARCH" == "arm64" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  fi
fi

# ---------------------------------------------------------------------------
log "4/8  nvm + Node.js $NODE_VERSION"
if [[ ! -d "$HOME/.nvm" ]]; then
  warn "installing nvm..."
  # タグ v0.39.7 固定 = 内容不変。NVM_INSTALL_SHA256 を渡せば供給網検証を強制できる。
  fetch_and_run "https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh" "nvm v0.39.7" "${NVM_INSTALL_SHA256:-}"
fi
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[[ -s "$NVM_DIR/nvm.sh" ]] && \. "$NVM_DIR/nvm.sh"

if nvm ls "$NODE_VERSION" >/dev/null 2>&1; then
  ok "Node $NODE_VERSION already installed"
else
  warn "installing Node $NODE_VERSION..."
  nvm install "$NODE_VERSION"
fi
nvm use "$NODE_VERSION" >/dev/null
nvm alias default "$NODE_VERSION" >/dev/null
ok "node $(node --version)"

# ---------------------------------------------------------------------------
log "5/8  pnpm + gh + claude"
if ! command -v pnpm >/dev/null 2>&1; then
  warn "installing pnpm..."
  npm install -g pnpm@11
fi
ok "pnpm $(pnpm --version)"

if ! command -v gh >/dev/null 2>&1; then
  warn "installing gh (GitHub CLI)..."
  brew install gh
fi
ok "gh $(gh --version | head -1)"

if ! command -v claude >/dev/null 2>&1; then
  warn "installing claude code..."
  npm install -g @anthropic-ai/claude-code
fi
ok "claude $(claude --version)"

if ! command -v jq >/dev/null 2>&1; then
  warn "installing jq (used by worker-launcher.sh)..."
  brew install jq
fi
ok "jq $(jq --version)"

# ---------------------------------------------------------------------------
log "6/8  Clone repo (if absent)"
mkdir -p "$WORK_DIR"
if [[ -d "$WORK_DIR/$REPO_NAME/.git" ]]; then
  ok "repo already cloned at $WORK_DIR/$REPO_NAME"
  ( cd "$WORK_DIR/$REPO_NAME" && git fetch origin --quiet && git checkout main && git pull --ff-only --quiet )
else
  warn "cloning $REPO_URL..."
  git clone "$REPO_URL" "$WORK_DIR/$REPO_NAME"
fi

# ---------------------------------------------------------------------------
log "7/8  Install workspace dependencies"
cd "$WORK_DIR/$REPO_NAME"
pnpm install --frozen-lockfile 2>&1 | tail -5 || warn "pnpm install had warnings"
ok "dependencies installed"

# ---------------------------------------------------------------------------
log "8/8  State directory"
mkdir -p "$HOME/.kimiterrace-orchestrator/workers"
mkdir -p "$HOME/.kimiterrace-orchestrator/logs"
mkdir -p "$HOME/work/.kimiterrace-workers"
ok "$HOME/.kimiterrace-orchestrator/{workers,logs} ready"

# ---------------------------------------------------------------------------
log "Authentication required (manual)"
echo
echo "  Run the following INTERACTIVELY (open these in Terminal.app, not over SSH):"
echo
echo "    gh auth login         # → choose GitHub.com / HTTPS / login with browser"
echo "    claude auth login     # → opens browser, sign into claude.ai"
echo
echo "  Verify:"
echo "    gh auth status"
echo "    claude -p 'say hi' --print --output-format text   # quick smoke test"
echo

# ---------------------------------------------------------------------------
log "Done"
printf "\nNext steps:\n"
printf "  1. From Windows orchestrator, edit scripts/orchestrator/config.json:\n"
printf "     - machines.mac-mini.enabled: true\n"
printf "     - machines.mac-mini.host: %s\n" "$(scutil --get LocalHostName 2>/dev/null || hostname).local"
printf "     - machines.mac-mini.user: %s\n" "$(whoami)"
printf "  2. From Windows: ssh-copy-id -i ~/.ssh/id_kimiterrace.pub %s@%s.local\n" "$(whoami)" "$(scutil --get LocalHostName 2>/dev/null || hostname)"
printf "  3. Test: powershell scripts/orchestrator/orchestrator.ps1 probe\n"
printf "\nMachine info for orchestrator config:\n"
printf "  Hostname: %s\n" "$(scutil --get LocalHostName 2>/dev/null || hostname).local"
printf "  User: %s\n" "$(whoami)"
printf "  Repo: %s\n" "$WORK_DIR/$REPO_NAME"
printf "  Total RAM: %s GB\n" "$(echo "scale=1; $(sysctl -n hw.memsize) / 1073741824" | bc)"
printf "  CPU cores: %s\n" "$(sysctl -n hw.logicalcpu)"
printf "\n"
