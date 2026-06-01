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
  param([int]$Issue, [string]$Branch, [string]$Worktree, [string]$RoleArg = "worker")
  # Reviewer uses a different brief template (PR review instructions, not implementation).
  # The Issue parameter is interpreted as PR number for reviewer.
  $templateName = if ($RoleArg -eq "reviewer") { "reviewer-brief.md.template" } else { "worker-brief.md.template" }
  $template = "$ScriptRoot/templates/$templateName"
  if (-not (Test-Path $template)) {
    return "Implement issue #$Issue. See CLAUDE.md for rules."
  }
  # -Encoding UTF8 is required on Windows PowerShell 5.1 — default is the
  # system code page (CP932 on Japanese Windows), which mojibake-corrupts
  # the UTF-8 template content.
  $brief = Get-Content -LiteralPath $template -Raw -Encoding UTF8
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

  $briefContent = Render-WorkerBrief -Issue $Issue -Branch $branchName -Worktree $worktreePath -RoleArg $RoleArg
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
    -LogPath $logPath -ProcessId 0

  $bashPath = if ($Config.bashPath) { $Config.bashPath } else { "bash" }
  if (-not (Test-Path $bashPath)) {
    throw "Configured bashPath does not exist: $bashPath. On Windows, point this at Git Bash (e.g. 'C:\Program Files\Git\bin\bash.exe'); plain 'bash' resolves to the WSL launcher which silently exits."
  }
  Push-Location $repoRoot
  try {
    $proc = Start-Process -FilePath $bashPath -ArgumentList @(
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

  $briefContent = Render-WorkerBrief -Issue $Issue -Branch $branchName -Worktree $worktreePath -RoleArg $RoleArg

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
  $skipped = New-Object System.Collections.Generic.List[string]
  $dry = [bool]$script:DryRun

  # Local worktree cleanup (#335).
  #
  # Reaping is gated on the AUTHORITATIVE PR-merged state (gh pr view), NOT on
  # `git branch --merged main`. With --squash merges the feature branch tip never becomes an
  # ancestor of main, so the old `branch --merged` gate never matched and worktrees leaked.
  # Reviewer worktrees are detached (no branch) and are reaped by role as a backstop for the
  # launcher self-delete (#332) when the launcher was SIGKILLed and its trap never ran.
  $repoRoot = (git rev-parse --show-toplevel).Trim()
  Get-WorkerStates | Where-Object {
    $_.status -in @("completed", "failed", "timeout") -and $_.worktree -and (Test-Path $_.worktree)
  } | ForEach-Object {
    $s = $_
    # Never touch locked agent worktrees (.claude/worktrees/*) or anything outside our base.
    if ($s.worktree -match '[\\/]\.claude[\\/]worktrees[\\/]') { return }

    $reason = $null
    if ($s.role -eq "reviewer") {
      $reason = "reviewer backstop"
    }
    elseif ($s.prNumber) {
      # Worker: reap only when its PR is authoritatively MERGED (handles squash merges).
      $prState = (gh pr view $s.prNumber --json state --jq '.state' 2>$null)
      if ($prState -eq "MERGED") { $reason = "PR #$($s.prNumber) MERGED" }
    }
    if (-not $reason) { return }

    # Safety valve: never force-remove a worktree with uncommitted changes (could be a concurrent
    # session still working in it). Skip and warn instead of destroying unsaved work.
    $dirty = git -C $s.worktree status --porcelain 2>$null
    if ($LASTEXITCODE -eq 0 -and $dirty) {
      Write-Host "[local] SKIP (uncommitted changes): $($s.worktree)"
      $skipped.Add("dirty:$($s.worktree)")
      return
    }

    if ($dry) {
      Write-Host "[dry-run] would remove ($reason): $($s.worktree)"
      $removed.Add("dryrun:$($s.worktree)")
      return
    }
    Write-Host "[local] Removing ($reason): $($s.worktree)"
    git -C $repoRoot worktree remove $s.worktree --force 2>&1 | Out-Null
    $removed.Add("local:$($s.worktree)")
  }

  # Remote cleanup via SSH (#335). Reap detached reviewer worktrees (br=HEAD, launcher-trap
  # backstop) plus branch-merged worker worktrees. NOTE: squash-merged remote *worker* worktrees
  # still rely on the branch-merged heuristic here; authoritative gh-state reaping over SSH is a
  # follow-up. The detached reaping covers the common reviewer leak. Honors dry-run.
  $dryFlag = if ($dry) { "1" } else { "0" }
  Get-EnabledMachines | Where-Object { $_.kind -eq "ssh" } | ForEach-Object {
    $m = $_
    $cmd = @"
cd $($m.remoteRepoPath) && \
git fetch origin && \
DRY=$dryFlag
for wt in `$(git worktree list --porcelain | awk '/^worktree/ {print `$2}' | grep -v "$($m.remoteRepoPath)$"); do
  br=`$(git -C "`$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [ "`$br" = "HEAD" ] || { [ -n "`$br" ] && git branch --merged main | grep -q "`$br"; }; then
    if [ "`$DRY" = "1" ]; then
      echo "would remove: `$wt"
    else
      echo "removing: `$wt"
      git worktree remove "`$wt" --force
    fi
  fi
done
"@
    $r = Invoke-SshCommand -Machine $m -Command $cmd -TimeoutSec 30
    if ($r.Stdout) {
      $r.Stdout -split "`n" | Where-Object { $_ -match "remov" } | ForEach-Object {
        $removed.Add("$($m.name):$_")
      }
    }
  }

  # In dry-run, do not prune state files either (purely a preview).
  if (-not $dry) { Remove-StaleStates -OlderThanDays $Config.logRetentionDays }

  [PSCustomObject]@{ Removed = $removed.ToArray(); Skipped = $skipped.ToArray(); DryRun = $dry } | Write-JsonOut
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
