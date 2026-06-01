#!/usr/bin/env bash
# Worker launcher — spawns a Claude Code worker against an issue.
#
# Invoked by orchestrator.ps1. Expected to:
#   1. Create a git worktree
#   2. Compose the brief from template + issue context
#   3. Run claude with the brief
#   4. Stream output to log
#   5. Update worker state JSON on exit
#
# SAFETY MODEL:
# - By default, runs with explicit --allowedTools / --disallowedTools and
#   --permission-mode from config.json
# - Destructive commands (rm, sudo, curl, npm -g) are blocked
# - Full unattended bypass requires unsafeAutoApprove=true in config
# - Workers cannot exfiltrate code via WebFetch unless explicitly allowed

set -euo pipefail

ROLE="${1:-}"            # "worker" or "reviewer"
ISSUE_NUMBER="${2:-}"    # GitHub issue number (or PR number for reviewer)
WORKER_ID="${3:-}"       # Unique id from orchestrator
STATE_PATH="${4:-}"      # State JSON path
LOG_PATH="${5:-}"        # Log output path
WORKTREE_PATH="${6:-}"   # Where to create the worktree
BRANCH_NAME="${7:-}"     # Branch to create
BRIEF_PATH="${8:-}"      # Path to pre-rendered brief

if [[ -z "$ROLE" || -z "$ISSUE_NUMBER" || -z "$WORKER_ID" || -z "$BRIEF_PATH" ]]; then
  echo "Usage: $0 <role> <issue> <worker_id> <state_path> <log_path> <worktree_path> <branch_name> <brief_path>" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_PATH"
}

update_state() {
  local key="$1" value="$2"
  if command -v jq >/dev/null 2>&1; then
    local tmp
    tmp="$(mktemp)"
    jq --arg k "$key" --arg v "$value" '.[$k] = $v' "$STATE_PATH" > "$tmp" && mv "$tmp" "$STATE_PATH"
  else
    powershell.exe -NoProfile -Command "
      \$s = Get-Content -LiteralPath '$STATE_PATH' -Raw | ConvertFrom-Json
      \$s.$key = '$value'
      \$s | ConvertTo-Json -Depth 5 | Out-File -LiteralPath '$STATE_PATH' -Encoding utf8
    " >/dev/null
  fi
}

cleanup() {
  local exit_code=$?
  log "Worker exiting with code $exit_code"
  if [[ $exit_code -eq 0 ]]; then
    update_state "status" "completed"
  else
    update_state "status" "failed"
  fi
  update_state "exitCode" "$exit_code"

  # Reviewer worktrees are detached (#67) + read-only + ephemeral. Being detached they
  # never match `git branch --merged main`, so orchestrator.ps1 Cmd-Cleanup cannot reclaim
  # them and they accumulate (#330). Remove at the source — the creator owns cleanup.
  # Worker worktrees are kept on purpose: the pushed PR branch and orchestrator inspection
  # still need them. cd out of the worktree first (Windows locks the cwd dir on remove).
  if [[ "$ROLE" == "reviewer" && -n "$WORKTREE_PATH" && -d "$WORKTREE_PATH" ]]; then
    log "Removing ephemeral reviewer worktree: $WORKTREE_PATH"
    cd "$REPO_ROOT" 2>/dev/null || true
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_PATH" 2>&1 | tee -a "$LOG_PATH" \
      || log "reviewer worktree remove warning (left for Cmd-Cleanup backstop)"
  fi
}
trap cleanup EXIT

log "=== Worker $WORKER_ID starting ==="
log "Role: $ROLE | Issue: #$ISSUE_NUMBER | Branch: $BRANCH_NAME"

# 両ロールとも専用 worktree で隔離して動かす (#67)。Reviewer も REPO_ROOT で直接動かすと、
# 誤って `gh pr checkout` / `git checkout` した際に Desktop Orchestrator の current branch を
# 奪ってしまう。Reviewer は read-only なので branch を作らず detached HEAD + pnpm install スキップ
# とし、軽量性を保ちつつ物理的に隔離する（テンプレ指示だけに頼らない defense in depth）。
if [[ -n "$WORKTREE_PATH" ]]; then
  if [[ -d "$WORKTREE_PATH" ]]; then
    log "Worktree already exists at $WORKTREE_PATH (reusing)"
  elif [[ "$ROLE" == "worker" ]]; then
    log "Creating worker worktree: $WORKTREE_PATH on branch $BRANCH_NAME"
    git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" main
  else
    log "Creating reviewer worktree (detached, isolated, no branch): $WORKTREE_PATH"
    git worktree add --detach "$WORKTREE_PATH" main
  fi
  cd "$WORKTREE_PATH"

  if [[ "$ROLE" == "worker" ]]; then
    log "Installing dependencies (pnpm install)…"
    if command -v pnpm >/dev/null 2>&1; then
      pnpm install --frozen-lockfile 2>&1 | tee -a "$LOG_PATH" || log "pnpm install warning"
    fi
  else
    log "Reviewer: skipping pnpm install (read-only review via gh pr diff)"
  fi
else
  log "No worktree path provided; running in repo root ($REPO_ROOT)"
  cd "$REPO_ROOT"
fi

# Read config
CONFIG_PATH="$REPO_ROOT/scripts/orchestrator/config.json"
# Portable config reader. grep -oP was unusable on BOTH hosts and silently fell
# back to DEFAULTS everywhere (so config.json's budget/allowedTools/
# disallowedTools were never honored): macOS BSD grep has no -P at all, and
# Git-Bash GNU grep refuses -P unless the locale is UTF-8/unibyte (it isn't by
# default → "grep: -P supports only unibyte and UTF-8 locales"). node is
# guaranteed present (pnpm requires it) and parses JSON identically on both,
# accepting the path Git emits (C:/… or POSIX).
_cfg_raw() {
  local key="$1"
  node -e 'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=c[process.argv[2]];process.stdout.write(v==null?"":String(v));}catch(e){}' "$CONFIG_PATH" "$key" 2>/dev/null
}
read_cfg() {
  local key="$1" default="$2" val
  val="$(_cfg_raw "$key")"
  [[ -n "$val" ]] && printf '%s' "$val" || printf '%s' "$default"
}
read_cfg_num() {
  local key="$1" default="$2" val
  val="$(_cfg_raw "$key")"
  [[ -n "$val" ]] && printf '%s' "$val" || printf '%s' "$default"
}
read_cfg_bool() {
  local key="$1" val
  val="$(_cfg_raw "$key")"
  [[ "$val" == "true" ]] && printf 'true' || printf 'false'
}

CLAUDE_BIN=$(read_cfg "claudeBin" "claude")
CLAUDE_MODEL=$(read_cfg "claudeModel" "claude-opus-4-7")
CLAUDE_EFFORT=$(read_cfg "claudeEffort" "medium")
PERMISSION_MODE=$(read_cfg "claudePermissionMode" "acceptEdits")
ALLOWED_TOOLS=$(read_cfg "claudeAllowedTools" "Bash Edit Write Read Glob Grep")
DISALLOWED_TOOLS=$(read_cfg "claudeDisallowedTools" "")
UNSAFE_AUTO=$(read_cfg_bool "unsafeAutoApprove")

if [[ "$ROLE" == "worker" ]]; then
  MAX_BUDGET=$(read_cfg_num "workerMaxBudgetUsd" "5")
  TIMEOUT_SEC=$(read_cfg_num "workerTimeoutSec" "1800")
else
  MAX_BUDGET=$(read_cfg_num "reviewerMaxBudgetUsd" "2")
  TIMEOUT_SEC=$(read_cfg_num "reviewerTimeoutSec" "900")
fi

# Build claude args. Safe defaults; bypass requires explicit config opt-in.
CLAUDE_ARGS=(
  --print
  --output-format stream-json
  --model "$CLAUDE_MODEL"
  --effort "$CLAUDE_EFFORT"
  --max-budget-usd "$MAX_BUDGET"
  --name "$WORKER_ID"
  --permission-mode "$PERMISSION_MODE"
  --allowedTools $ALLOWED_TOOLS
  --verbose
)

if [[ -n "$DISALLOWED_TOOLS" ]]; then
  CLAUDE_ARGS+=(--disallowedTools $DISALLOWED_TOOLS)
fi

if [[ "$UNSAFE_AUTO" == "true" ]]; then
  log "WARNING: unsafeAutoApprove=true — running with bypassPermissions"
  CLAUDE_ARGS=(--print --dangerously-skip-permissions
               --output-format stream-json
               --model "$CLAUDE_MODEL" --effort "$CLAUDE_EFFORT"
               --max-budget-usd "$MAX_BUDGET" --name "$WORKER_ID" --verbose)
fi

log "Invoking claude (model=$CLAUDE_MODEL effort=$CLAUDE_EFFORT budget=\$$MAX_BUDGET timeout=${TIMEOUT_SEC}s mode=$PERMISSION_MODE)"

# Use `timeout` if available (coreutils on git-bash usually has it)
if command -v timeout >/dev/null 2>&1; then
  timeout "${TIMEOUT_SEC}s" "$CLAUDE_BIN" "${CLAUDE_ARGS[@]}" < "$BRIEF_PATH" 2>&1 | tee -a "$LOG_PATH"
else
  "$CLAUDE_BIN" "${CLAUDE_ARGS[@]}" < "$BRIEF_PATH" 2>&1 | tee -a "$LOG_PATH"
fi

CLAUDE_EXIT=${PIPESTATUS[0]}
log "claude exited with $CLAUDE_EXIT"

# Try to extract PR number from log (worker should have created one)
PR_NUM=$(grep -oP 'pull/\K\d+' "$LOG_PATH" | tail -1 || echo "")
if [[ -n "$PR_NUM" ]]; then
  update_state "prNumber" "$PR_NUM"
  log "Detected PR #$PR_NUM"
fi

exit "$CLAUDE_EXIT"
