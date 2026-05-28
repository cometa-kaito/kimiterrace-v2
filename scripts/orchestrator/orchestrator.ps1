<#
.SYNOPSIS
  Orchestrator entry point. Subcommands: probe, plan, spawn, status, cleanup, dry-run.

.DESCRIPTION
  Resource-aware scheduler for Worker / Reviewer Claude sessions.

  Typical usage:
    # Show current capacity
    .\orchestrator.ps1 probe

    # Plan: what would be spawned for these issues (no actual spawn)
    .\orchestrator.ps1 plan -Issues 11,14,18

    # Spawn workers (subject to capacity limits)
    .\orchestrator.ps1 spawn -Issues 11,14,18

    # Show running workers
    .\orchestrator.ps1 status

    # Sync state (mark exited workers as completed/failed)
    .\orchestrator.ps1 sync

    # Cleanup finished worktrees + old state files
    .\orchestrator.ps1 cleanup

.NOTES
  This script does not actually invoke claude itself. It delegates to
  scripts/orchestrator/worker-launcher.sh in detached subprocess.

  The orchestrator is the Desktop Claude's interface for parallel work.
  Desktop Claude should call this via Bash; it must not perform
  implementation itself (Orchestrator Mode — see CLAUDE.md).
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet("probe", "plan", "spawn", "status", "sync", "cleanup", "version")]
  [string]$Command,

  [int[]]$Issues = @(),
  [ValidateSet("worker", "reviewer")][string]$Role = "worker",
  [int]$MaxWorkers = 0,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ScriptRoot = $PSScriptRoot

# Source libs
. "$ScriptRoot/lib/state.ps1"

$ConfigPath = "$ScriptRoot/config.json"
$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

function Format-Json {
  param($Obj)
  $Obj | ConvertTo-Json -Depth 10
}

function Cmd-Probe {
  $probe = & "$ScriptRoot/lib/probe.ps1"
  Format-Json $probe
}

function Cmd-Plan {
  param([int[]]$IssueList, [string]$RoleArg)

  $probe = & "$ScriptRoot/lib/probe.ps1"
  Sync-WorkerStatuses
  $active = (Get-WorkerStates -StatusFilter "running" | Where-Object { $_.role -eq $RoleArg }).Count
  $cap = & "$ScriptRoot/lib/capacity.ps1" -Probe $probe -ActiveWorkers $active -Role $RoleArg

  $available = $cap.MaxConcurrent
  $toSpawn = if ($IssueList.Count -gt 0) {
    $IssueList | Select-Object -First $available
  } else {
    @()
  }
  $deferred = if ($IssueList.Count -gt $available) {
    $IssueList | Select-Object -Skip $available
  } else {
    @()
  }

  $plan = [PSCustomObject]@{
    Probe         = $probe
    Capacity      = $cap
    RequestedIssues = $IssueList
    WillSpawn     = $toSpawn
    Deferred      = $deferred
    Notes         = if ($cap.CpuBlocked) {
      "CPU load above threshold ($($probe.CpuLoadPct)%). No workers will spawn now."
    } elseif ($available -eq 0) {
      "No capacity. Wait for active workers to finish or free resources."
    } else {
      "Ready to spawn $($toSpawn.Count) of $($IssueList.Count) requested."
    }
  }
  Format-Json $plan
}

function Cmd-Spawn {
  param([int[]]$IssueList, [string]$RoleArg, [switch]$DryRunFlag)

  $probe = & "$ScriptRoot/lib/probe.ps1"
  Sync-WorkerStatuses
  $active = (Get-WorkerStates -StatusFilter "running" | Where-Object { $_.role -eq $RoleArg }).Count
  $cap = & "$ScriptRoot/lib/capacity.ps1" -Probe $probe -ActiveWorkers $active -Role $RoleArg

  if ($cap.MaxConcurrent -eq 0) {
    Write-Host "No capacity available. Reason:"
    $cap.Reasoning | ForEach-Object { Write-Host "  $_" }
    return
  }

  $issuesToSpawn = $IssueList | Select-Object -First $cap.MaxConcurrent
  $spawned = @()

  foreach ($issue in $issuesToSpawn) {
    $worktreeBase = $Config.worktreeBaseDir
    if ($worktreeBase -notmatch '^[A-Za-z]:|^/') {
      # Relative path: resolve against repo root
      $repoRoot = (git rev-parse --show-toplevel).Trim()
      $worktreeBase = Join-Path $repoRoot $worktreeBase
    }
    if (-not (Test-Path $worktreeBase)) {
      New-Item -ItemType Directory -Path $worktreeBase -Force | Out-Null
    }

    $shortName = "issue-$issue"
    $worktreePath = Join-Path $worktreeBase "worker-$shortName"
    $branchName = "feat/$issue-orchestrated"

    $dirs = Get-StateDir
    $logPath = Join-Path $dirs.Logs "worker-issue-$issue-$(Get-Date -Format 'yyyyMMddTHHmmss').log"

    $briefPath = Join-Path $dirs.Logs "worker-issue-$issue-brief.md"
    # Brief content is rendered separately; for now place a placeholder if missing
    if (-not (Test-Path $briefPath)) {
      $template = "$ScriptRoot/templates/worker-brief.md.template"
      if (Test-Path $template) {
        $brief = Get-Content -LiteralPath $template -Raw
        $brief = $brief -replace '\{\{ISSUE_NUMBER\}\}', $issue
        $brief = $brief -replace '\{\{BRANCH_NAME\}\}', $branchName
        $brief = $brief -replace '\{\{WORKTREE_PATH\}\}', ($worktreePath -replace '\\', '/')
        $brief | Out-File -LiteralPath $briefPath -Encoding utf8
      } else {
        "Implement issue #$issue. See CLAUDE.md for rules." |
          Out-File -LiteralPath $briefPath -Encoding utf8
      }
    }

    if ($DryRunFlag) {
      Write-Host "DRY-RUN: would spawn $RoleArg for issue #$issue"
      Write-Host "  Worktree: $worktreePath"
      Write-Host "  Branch:   $branchName"
      Write-Host "  Log:      $logPath"
      Write-Host "  Brief:    $briefPath"
      continue
    }

    # Pre-create state file with placeholder PID
    $state = New-WorkerState -Role $RoleArg -Issue $issue `
      -Branch $branchName -Worktree $worktreePath `
      -LogPath $logPath -Pid 0

    # Spawn the launcher in detached bash
    $bashCmd = @(
      "bash",
      "scripts/orchestrator/worker-launcher.sh",
      $RoleArg,
      $issue,
      $state.id,
      $state.StatePath,
      $logPath,
      $worktreePath,
      $branchName,
      $briefPath
    ) -join " "

    Push-Location (git rev-parse --show-toplevel).Trim()
    try {
      $proc = Start-Process -FilePath "bash" `
        -ArgumentList @(
          "scripts/orchestrator/worker-launcher.sh",
          $RoleArg,
          $issue,
          $state.id,
          "`"$($state.StatePath)`"",
          "`"$logPath`"",
          "`"$worktreePath`"",
          $branchName,
          "`"$briefPath`""
        ) `
        -PassThru -NoNewWindow:$false -WindowStyle Hidden

      Update-WorkerState -Id $state.id -Patch @{ pid = $proc.Id } | Out-Null
      Write-Host "Spawned $RoleArg-$($state.id) (PID $($proc.Id)) for issue #$issue"
      $spawned += [PSCustomObject]@{
        Id     = $state.id
        Pid    = $proc.Id
        Issue  = $issue
        Branch = $branchName
        Log    = $logPath
      }
    } finally {
      Pop-Location
    }
  }

  Format-Json $spawned
}

function Cmd-Status {
  Sync-WorkerStatuses
  $all = Get-WorkerStates
  $summary = [PSCustomObject]@{
    Running    = @($all | Where-Object { $_.status -eq "running" })
    Completed  = @($all | Where-Object { $_.status -eq "completed" })
    Failed     = @($all | Where-Object { $_.status -eq "failed" })
    Total      = $all.Count
  }
  Format-Json $summary
}

function Cmd-Sync {
  Sync-WorkerStatuses
  Cmd-Status
}

function Cmd-Cleanup {
  Sync-WorkerStatuses

  # Remove worktrees of merged/closed PRs
  $repoRoot = (git rev-parse --show-toplevel).Trim()
  $worktrees = git -C $repoRoot worktree list --porcelain | Out-String
  $removed = @()

  Get-WorkerStates | Where-Object { $_.status -in @("completed", "failed") -and $_.worktree -and (Test-Path $_.worktree) } |
    ForEach-Object {
      $s = $_
      # If the branch has been merged or PR closed, remove the worktree
      $isMerged = $false
      if ($s.branch) {
        $mergeCheck = git -C $repoRoot branch --merged main 2>$null | Out-String
        if ($mergeCheck -match [regex]::Escape($s.branch)) { $isMerged = $true }
      }
      if ($isMerged) {
        Write-Host "Removing merged worktree: $($s.worktree)"
        git -C $repoRoot worktree remove $s.worktree --force 2>&1 | Out-Null
        $removed += $s.worktree
      }
    }

  # Prune old state files
  Remove-StaleStates -OlderThanDays $Config.logRetentionDays

  Format-Json @{ RemovedWorktrees = $removed }
}

function Cmd-Version {
  [PSCustomObject]@{
    OrchestratorVersion = "0.1.0"
    ConfigPath          = $ConfigPath
    ClaudeBin           = $Config.claudeBin
    ClaudeVersion       = (& claude --version 2>&1 | Out-String).Trim()
  } | Format-Json
}

# Dispatch
switch ($Command) {
  "probe"   { Cmd-Probe }
  "plan"    { Cmd-Plan -IssueList $Issues -RoleArg $Role }
  "spawn"   { Cmd-Spawn -IssueList $Issues -RoleArg $Role -DryRunFlag:$DryRun }
  "status"  { Cmd-Status }
  "sync"    { Cmd-Sync }
  "cleanup" { Cmd-Cleanup }
  "version" { Cmd-Version }
}
