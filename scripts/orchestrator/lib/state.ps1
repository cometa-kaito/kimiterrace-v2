<#
.SYNOPSIS
  Read / write / scan worker state files for the orchestrator.

.DESCRIPTION
  Each spawned worker has a state JSON at:
    $stateDir/workers/<worker-id>.json

  Schema:
    {
      "id": "worker-2026-05-28T15-30-00Z-issue-15",
      "role": "worker" | "reviewer",
      "pid": 12345,
      "issue": 15,
      "branch": "feat/15-postgres-schema",
      "worktree": "C:\\path\\to\\worktree",
      "logPath": "C:\\path\\to\\log",
      "startedAt": "2026-05-28T15:30:00Z",
      "status": "running" | "completed" | "failed" | "timeout",
      "prNumber": null,
      "exitCode": null
    }
#>

function Get-StateDir {
  param([string]$ConfigPath = "$PSScriptRoot/../config.json")
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $dir = $config.stateDir -replace "^~", $env:USERPROFILE
  $workersDir = Join-Path $dir "workers"
  $logsDir = Join-Path $dir "logs"
  if (-not (Test-Path $workersDir)) { New-Item -ItemType Directory -Path $workersDir -Force | Out-Null }
  if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
  [PSCustomObject]@{ Root = $dir; Workers = $workersDir; Logs = $logsDir }
}

function New-WorkerState {
  param(
    [Parameter(Mandatory)][ValidateSet("worker", "reviewer")][string]$Role,
    [Parameter(Mandatory)][int]$Issue,
    [Parameter(Mandatory)][string]$Branch,
    [Parameter(Mandatory)][string]$Worktree,
    [Parameter(Mandatory)][string]$LogPath,
    [Parameter(Mandatory)][int]$Pid
  )
  $dirs = Get-StateDir
  $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ssZ")
  $id = "$Role-$timestamp-issue-$Issue"

  $state = [PSCustomObject]@{
    id        = $id
    role      = $Role
    pid       = $Pid
    issue     = $Issue
    branch    = $Branch
    worktree  = $Worktree
    logPath   = $LogPath
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    status    = "running"
    prNumber  = $null
    exitCode  = $null
  }

  $path = Join-Path $dirs.Workers "$id.json"
  $state | ConvertTo-Json -Depth 5 | Out-File -LiteralPath $path -Encoding utf8
  $state | Add-Member -NotePropertyName StatePath -NotePropertyValue $path -PassThru
}

function Get-WorkerStates {
  param([string]$StatusFilter = "*")
  $dirs = Get-StateDir
  Get-ChildItem -LiteralPath $dirs.Workers -Filter "*.json" -ErrorAction SilentlyContinue |
    ForEach-Object {
      try {
        $s = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
        $s | Add-Member -NotePropertyName StatePath -NotePropertyValue $_.FullName -PassThru
      } catch {
        Write-Warning "Corrupt state file: $($_.FullName)"
      }
    } |
    Where-Object { $StatusFilter -eq "*" -or $_.status -eq $StatusFilter }
}

function Update-WorkerState {
  param(
    [Parameter(Mandatory)][string]$Id,
    [hashtable]$Patch
  )
  $dirs = Get-StateDir
  $path = Join-Path $dirs.Workers "$Id.json"
  if (-not (Test-Path $path)) {
    throw "State not found: $Id"
  }
  $state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  foreach ($k in $Patch.Keys) {
    if ($state.PSObject.Properties.Name -contains $k) {
      $state.$k = $Patch[$k]
    } else {
      $state | Add-Member -NotePropertyName $k -NotePropertyValue $Patch[$k]
    }
  }
  $state | ConvertTo-Json -Depth 5 | Out-File -LiteralPath $path -Encoding utf8
  $state
}

function Sync-WorkerStatuses {
  # Walk all "running" states; if PID is gone, mark completed/failed based on log.
  $running = Get-WorkerStates -StatusFilter "running"
  foreach ($s in $running) {
    $proc = Get-Process -Id $s.pid -ErrorAction SilentlyContinue
    if (-not $proc) {
      $exitCode = 0
      $newStatus = "completed"
      if (Test-Path $s.logPath) {
        $tail = Get-Content -LiteralPath $s.logPath -Tail 50 -ErrorAction SilentlyContinue
        if ($tail -match "ERROR|BLOCKED|FATAL") { $newStatus = "failed" }
      }
      Update-WorkerState -Id $s.id -Patch @{
        status   = $newStatus
        exitCode = $exitCode
      } | Out-Null
    }
  }
}

function Remove-StaleStates {
  param([int]$OlderThanDays = 7)
  $dirs = Get-StateDir
  $cutoff = (Get-Date).AddDays(-$OlderThanDays)
  Get-ChildItem -LiteralPath $dirs.Workers -Filter "*.json" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
      $s = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
      if ($s.status -ne "running") {
        Remove-Item -LiteralPath $_.FullName -Force
      }
    }
}
