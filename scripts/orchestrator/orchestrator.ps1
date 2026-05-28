<#
.SYNOPSIS
  Multi-machine orchestrator. Subcommands: probe, plan, spawn, status, sync, cleanup, version.

.DESCRIPTION
  Resource-aware scheduler for Worker / Reviewer Claude sessions.
  Supports multiple machines (local + remote via SSH).

  Examples:
    .\orchestrator.ps1 probe
    .\orchestrator.ps1 plan -Issues 11,14,18
    .\orchestrator.ps1 spawn -Issues 11,14,18 -DryRun
    .\orchestrator.ps1 spawn -Issues 11,14,18
    .\orchestrator.ps1 status
    .\orchestrator.ps1 sync
    .\orchestrator.ps1 cleanup
    .\orchestrator.ps1 version
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet("probe", "plan", "spawn", "status", "sync", "cleanup", "version")]
  [string]$Command,

  [int[]]$Issues = @(),
  [ValidateSet("worker", "reviewer")][string]$Role = "worker",
  [int]$MaxWorkers = 0,
  [switch]$DryRun,
  [string]$Machine = ""
)

$ErrorActionPreference = "Stop"
$ScriptRoot = $PSScriptRoot

. "$ScriptRoot/lib/state.ps1"
. "$ScriptRoot/lib/ssh.ps1"

$ConfigPath = "$ScriptRoot/config.json"
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Get-EnabledMachines {
  $names = $Config.machines.PSObject.Properties.Name
  $list = foreach ($n in $names) {
    $m = $Config.machines.$n
    if ($m.enabled) {
      $m | Add-Member -NotePropertyName name -NotePropertyValue $n -Force -PassThru
    }
  }
  return @($list)
}

function Probe-Machine {
  param([Parameter(Mandatory)][PSCustomObject]$M)
  switch ($M.kind) {
    "local" { & "$ScriptRoot/lib/probe.ps1" }
    "ssh"   { Invoke-RemoteProbe -Machine $M }
    default { [PSCustomObject]@{ Error = "Unknown machine kind: $($M.kind)" } }
  }
}

function Get-AllStates {
  # Local states
  $local = @(Get-WorkerStates)
  # Remote states from each enabled ssh machine
  $remoteMachines = Get-EnabledMachines | Where-Object { $_.kind -eq "ssh" }
  $remote = foreach ($m in $remoteMachines) {
    Get-RemoteWorkerStates -Machine $m | ForEach-Object {
      $_ | Add-Member -NotePropertyName machine -NotePropertyValue $m.name -Force -PassThru
    }
  }
  @($local) + @($remote) | Where-Object { $_ }
}

function Count-ActiveOnMachine {
  param([string]$MachineName, [string]$RoleArg)
  (Get-AllStates |
    Where-Object { $_.status -eq "running" -and $_.role -eq $RoleArg -and
                   (($MachineName -eq "local-windows" -and -not $_.machine) -or
                    $_.machine -eq $MachineName) }
  ).Count
}

function Write-JsonOut {
  [CmdletBinding()]
  param(
    [Parameter(ValueFromPipeline = $true, Position = 0)]
    $Obj
  )
  process {
    $Obj | ConvertTo-Json -Depth 10
  }
}

function Cmd-Probe {
  $machines = Get-EnabledMachines
  $report = [ordered]@{}
  foreach ($m in $machines) {
    $report[$m.name] = Probe-Machine -M $m
  }
  Write-JsonOut $report
}

function Compute-Plan {
  param([string]$RoleArg, [int[]]$IssueList)

  Sync-WorkerStatuses
  $machines = Get-EnabledMachines

  $perMachine = foreach ($m in $machines) {
    $p = Probe-Machine -M $m
    $active = Count-ActiveOnMachine -MachineName $m.name -RoleArg $RoleArg
    $cap = & "$ScriptRoot/lib/capacity.ps1" -Probe $p -Machine $m -ActiveWorkers $active -Role $RoleArg
    [PSCustomObject]@{
      Name     = $m.name
      Kind     = $m.kind
      Probe    = $p
      Capacity = $cap
    }
  }

  # Routing: preferRemote → remote first, then local
  if ($Config.routing.preferRemote) {
    $ordered = @($perMachine | Where-Object { $_.Kind -eq "ssh" }) +
               @($perMachine | Where-Object { $_.Kind -eq "local" })
  } else {
    $ordered = @($perMachine | Where-Object { $_.Kind -eq "local" }) +
               @($perMachine | Where-Object { $_.Kind -eq "ssh" })
  }

  $totalAvailable = 0
  foreach ($mp in $ordered) { $totalAvailable += $mp.Capacity.MaxConcurrent }

  # Greedy assign issues to machines with capacity
  $assignments = New-Object System.Collections.Generic.List[object]
  $remainingByMachine = @{}
  foreach ($mp in $ordered) { $remainingByMachine[$mp.Name] = $mp.Capacity.MaxConcurrent }

  foreach ($issue in $IssueList) {
    $target = $ordered | Where-Object { $remainingByMachine[$_.Name] -gt 0 } | Select-Object -First 1
    if ($target) {
      $assignments.Add([PSCustomObject]@{
        Issue   = $issue
        Machine = $target.Name
        Kind    = $target.Kind
      })
      $remainingByMachine[$target.Name] -= 1
    }
  }

  $deferred = $IssueList | Where-Object { -not ($assignments | Where-Object { $_.Issue -eq $_ }) }
  # Simpler: deferred = issues that didn't get assigned
  $assignedIssues = $assignments | ForEach-Object { $_.Issue }
  $deferred = $IssueList | Where-Object { $_ -notin $assignedIssues }

  [PSCustomObject]@{
    PerMachine     = $perMachine
    TotalAvailable = $totalAvailable
    Assignments    = $assignments.ToArray()
    Deferred       = @($deferred)
    Notes          = if ($totalAvailable -eq 0) {
      "No capacity on any enabled machine."
    } else {
      "Will spawn $($assignments.Count) of $($IssueList.Count) requested across $((($assignments | ForEach-Object { $_.Machine }) | Sort-Object -Unique).Count) machine(s)."
    }
  }
}

function Cmd-Plan {
  $plan = Compute-Plan -RoleArg $Role -IssueList $Issues
  Write-JsonOut $plan
}

function Render-WorkerBrief {
  param([int]$Issue, [string]$Branch, [string]$Worktree)
  $template = "$ScriptRoot/templates/worker-brief.md.template"
  if (-not (Test-Path $template)) {
    return "Implement issue #$Issue. See CLAUDE.md for rules."
  }
  $brief = Get-Content -LiteralPath $template -Raw
  $brief = $brief -replace '\{\{ISSUE_NUMBER\}\}', $Issue
  $brief = $brief -replace '\{\{BRANCH_NAME\}\}', $Branch
  $brief = $brief -replace '\{\{WORKTREE_PATH\}\}', ($Worktree -replace '\\', '/')
  return $brief
}

function Spawn-LocalWorker {
  param([PSCustomObject]$M, [int]$Issue, [string]$RoleArg, [switch]$DryRunFlag)

  $repoRoot = (git rev-parse --show-toplevel).Trim()
  $worktreeBase = $M.worktreeBaseDir
  if ($worktreeBase -notmatch '^[A-Za-z]:|^/') {
    $worktreeBase = Join-Path $repoRoot $worktreeBase
  }
  if (-not (Test-Path $worktreeBase) -and -not $DryRunFlag) {
    New-Item -ItemType Directory -Path $worktreeBase -Force | Out-Null
  }

  $shortName = "issue-$Issue"
  $worktreePath = Join-Path $worktreeBase "worker-$shortName"
  $branchName = "feat/$Issue-orchestrated"
  $dirs = Get-StateDir
  $logPath = Join-Path $dirs.Logs "worker-issue-$Issue-$(Get-Date -Format 'yyyyMMddTHHmmss').log"
  $briefPath = Join-Path $dirs.Logs "worker-issue-$Issue-brief.md"

  $briefContent = Render-WorkerBrief -Issue $Issue -Branch $branchName -Worktree $worktreePath
  if (-not $DryRunFlag) {
    $briefContent | Out-File -LiteralPath $briefPath -Encoding utf8
  }

  if ($DryRunFlag) {
    return [PSCustomObject]@{
      DryRun = $true
      Machine = $M.name
      Issue = $Issue
      Worktree = $worktreePath
      Branch = $branchName
      Log = $logPath
    }
  }

  $state = New-WorkerState -Role $RoleArg -Issue $Issue `
    -Branch $branchName -Worktree $worktreePath `
    -LogPath $logPath -Pid 0

  Push-Location $repoRoot
  try {
    $proc = Start-Process -FilePath "bash" -ArgumentList @(
      "scripts/orchestrator/worker-launcher.sh",
      $RoleArg, $Issue, $state.id,
      "`"$($state.StatePath)`"",
      "`"$logPath`"",
      "`"$worktreePath`"",
      $branchName,
      "`"$briefPath`""
    ) -PassThru -WindowStyle Hidden
    Update-WorkerState -Id $state.id -Patch @{ pid = $proc.Id } | Out-Null
    return [PSCustomObject]@{
      Id = $state.id
      Machine = $M.name
      Pid = $proc.Id
      Issue = $Issue
      Branch = $branchName
      Log = $logPath
    }
  } finally {
    Pop-Location
  }
}

function Spawn-RemoteWorker {
  param([PSCustomObject]$M, [int]$Issue, [string]$RoleArg, [switch]$DryRunFlag)

  $workerId = "worker-$(Get-Date -Format 'yyyyMMddTHHmmss')-issue-$Issue"
  $branchName = "feat/$Issue-orchestrated"
  $worktreePath = "$($M.worktreeBaseDir)/worker-issue-$Issue"

  $briefContent = Render-WorkerBrief -Issue $Issue -Branch $branchName -Worktree $worktreePath

  if ($DryRunFlag) {
    return [PSCustomObject]@{
      DryRun = $true
      Machine = $M.name
      Issue = $Issue
      Worktree = $worktreePath
      Branch = $branchName
    }
  }

  $r = Start-RemoteWorker -Machine $M -Role $RoleArg -Issue $Issue `
         -WorkerId $workerId -BranchName $branchName -BriefContent $briefContent
  $r
}

function Cmd-Spawn {
  $plan = Compute-Plan -RoleArg $Role -IssueList $Issues
  if ($plan.Assignments.Count -eq 0) {
    Write-Host "No capacity. Reasoning:"
    foreach ($pm in $plan.PerMachine) {
      Write-Host "  [$($pm.Name)] $($pm.Capacity.Reasoning -join '; ')"
    }
    Write-JsonOut $plan
    return
  }

  $machinesByName = @{}
  foreach ($pm in $plan.PerMachine) { $machinesByName[$pm.Name] = $pm }

  $results = foreach ($a in $plan.Assignments) {
    $m = (Get-EnabledMachines | Where-Object { $_.name -eq $a.Machine })
    if ($a.Kind -eq "local") {
      Spawn-LocalWorker -M $m -Issue $a.Issue -RoleArg $Role -DryRunFlag:$DryRun
    } else {
      Spawn-RemoteWorker -M $m -Issue $a.Issue -RoleArg $Role -DryRunFlag:$DryRun
    }
  }

  [PSCustomObject]@{
    Spawned  = $results
    Deferred = $plan.Deferred
  } | Write-JsonOut
}

function Cmd-Status {
  Sync-WorkerStatuses
  $all = Get-AllStates
  [PSCustomObject]@{
    Running    = @($all | Where-Object { $_.status -eq "running" })
    Completed  = @($all | Where-Object { $_.status -eq "completed" })
    Failed     = @($all | Where-Object { $_.status -eq "failed" })
    Total      = $all.Count
  } | Write-JsonOut
}

function Cmd-Sync {
  Sync-WorkerStatuses
  Cmd-Status
}

function Cmd-Cleanup {
  Sync-WorkerStatuses
  $removed = New-Object System.Collections.Generic.List[string]

  # Local worktree cleanup: remove worktrees for merged branches
  $repoRoot = (git rev-parse --show-toplevel).Trim()
  Get-WorkerStates | Where-Object {
    $_.status -in @("completed", "failed") -and $_.worktree -and (Test-Path $_.worktree)
  } | ForEach-Object {
    $s = $_
    $merged = git -C $repoRoot branch --merged main 2>$null | Out-String
    if ($merged -match [regex]::Escape($s.branch)) {
      Write-Host "[local] Removing merged worktree: $($s.worktree)"
      git -C $repoRoot worktree remove $s.worktree --force 2>&1 | Out-Null
      $removed.Add("local:$($s.worktree)")
    }
  }

  # Remote cleanup via SSH
  Get-EnabledMachines | Where-Object { $_.kind -eq "ssh" } | ForEach-Object {
    $m = $_
    $cmd = @"
cd $($m.remoteRepoPath) && \
git fetch origin && \
for wt in `$(git worktree list --porcelain | awk '/^worktree/ {print `$2}' | grep -v "$($m.remoteRepoPath)$"); do
  br=`$(git -C "`$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [ -n "`$br" ] && git branch --merged main | grep -q "`$br"; then
    echo "removing: `$wt"
    git worktree remove "`$wt" --force
  fi
done
"@
    $r = Invoke-SshCommand -Machine $m -Command $cmd -TimeoutSec 30
    if ($r.Stdout) {
      $r.Stdout -split "`n" | Where-Object { $_ -match "removing:" } | ForEach-Object {
        $removed.Add("$($m.name):$_")
      }
    }
  }

  Remove-StaleStates -OlderThanDays $Config.logRetentionDays

  [PSCustomObject]@{ Removed = $removed.ToArray() } | Write-JsonOut
}

function Cmd-Version {
  [PSCustomObject]@{
    OrchestratorVersion = "0.2.0"
    ConfigPath          = $ConfigPath
    ClaudeBin           = $Config.claudeBin
    Machines            = (Get-EnabledMachines | ForEach-Object {
      [PSCustomObject]@{ Name = $_.name; Kind = $_.kind; Host = $_.host }
    })
  } | Write-JsonOut
}

switch ($Command) {
  "probe"   { Cmd-Probe }
  "plan"    { Cmd-Plan }
  "spawn"   { Cmd-Spawn }
  "status"  { Cmd-Status }
  "sync"    { Cmd-Sync }
  "cleanup" { Cmd-Cleanup }
  "version" { Cmd-Version }
}
