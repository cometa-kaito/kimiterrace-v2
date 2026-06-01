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

  # Reconcile remote worker states too: mark crashed/SIGKILLed remote workers whose
  # tmux window is gone as failed. Sync-WorkerStatuses above only checks local PIDs;
  # without this a remote state stuck at "running" would make the in-flight dedup
  # below permanently block re-dispatch of that issue (Reviewer Low-1 on PR #354).
  foreach ($rm in @($machines | Where-Object { $_.kind -eq "ssh" })) {
    Sync-RemoteWorkerStatuses -Machine $rm
  }

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

  # Cross-session dispatch dedup: skip issues that already have a RUNNING worker on
  # ANY machine. Get-AllStates aggregates remote worker-state JSONs, so a worker that
  # a parallel orchestrator session dispatched to the Mac is visible here even though
  # it has no PR and no local worktree yet (those are the only signals a GitHub/local
  # check sees). Without this, the same issue is double-dispatched into one shared
  # remote worktree (race observed 2026-06-01: issue #347 dispatched 3x by concurrent
  # sessions, corrupting the worktree). This is not an atomic lock: two sessions that
  # check simultaneously can still both dispatch, but it eliminates the common case of
  # piling onto an already-running worker.
  $inFlightIssues = @(
    Get-AllStates |
      Where-Object { $_.status -eq "running" -and $null -ne $_.issue } |
      ForEach-Object { [int]$_.issue }
  ) | Select-Object -Unique
  $alreadyInFlight = New-Object System.Collections.Generic.List[object]

  foreach ($issue in $IssueList) {
    if ($inFlightIssues -contains [int]$issue) {
      $alreadyInFlight.Add($issue)
      continue
    }
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

  $assignedIssues = $assignments | ForEach-Object { $_.Issue }
  # Deferred = requested but neither assigned nor already in-flight (i.e. out of capacity).
  $deferred = $IssueList | Where-Object { $_ -notin $assignedIssues -and $_ -notin $inFlightIssues }

  [PSCustomObject]@{
    PerMachine      = $perMachine
    TotalAvailable  = $totalAvailable
    Assignments     = $assignments.ToArray()
    Deferred        = @($deferred)
    AlreadyInFlight = @($alreadyInFlight.ToArray())
    Notes           = if ($totalAvailable -eq 0) {
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
    if (@($plan.AlreadyInFlight).Count -gt 0) {
      Write-Host "Nothing to spawn: requested issue(s) already have a running worker: $(@($plan.AlreadyInFlight) -join ', ')"
    } else {
      Write-Host "No capacity. Reasoning:"
      foreach ($pm in $plan.PerMachine) {
        Write-Host "  [$($pm.Name)] $($pm.Capacity.Reasoning -join '; ')"
      }
    }
    Write-JsonOut $plan
    return
  }
  if (@($plan.AlreadyInFlight).Count -gt 0) {
    Write-Host "Skipping issue(s) already in flight (deduped across sessions): $(@($plan.AlreadyInFlight) -join ', ')"
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
    Spawned         = $results
    Deferred        = $plan.Deferred
    AlreadyInFlight = $plan.AlreadyInFlight
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
    # Note: this fails "open" only when `git status` itself errors (corrupt/prunable worktree); by
    # then the worktree already passed the MERGED gate (worker) or is a detached reviewer, so
    # force-removing it is acceptable even if dirty-detection could not run.
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
    # GC the merged worker branch too (#376): leaving feat/N-orchestrated behind makes a re-dispatch
    # of the same issue fail at `git worktree add -b`. Only workers create a branch (reviewers run
    # detached), and we reach here only when that worker's PR is MERGED, so the delete is safe.
    if ($s.role -eq "worker" -and $s.branch) {
      # Swallow failures (most commonly: the branch is already gone). Under the script's
      # $ErrorActionPreference="Stop", a native stderr write ("error: branch ... not found") is a
      # terminating error that would otherwise abort the whole cleanup loop and leak the remaining
      # worktrees. try/catch mirrors the remote path's `|| true`, keeping branch GC fail-open.
      try { git -C $repoRoot branch -D $s.branch 2>&1 | Out-Null } catch {}
    }
    $removed.Add("local:$($s.worktree)")
  }

  # Remote cleanup via SSH (#335). Reaps three classes of leaked remote worktree:
  #   1. squash-merged *worker* worktrees (authoritative, NEW) - see below;
  #   2. detached reviewer worktrees (br=HEAD, launcher-trap backstop);
  #   3. branch-merged worktrees (fast-forward merges; kept as a harmless fallback).
  #
  # Squash-merged workers previously leaked: `git branch --merged main` never matches a
  # squash-merged branch (its tip never becomes an ancestor of main), the exact root cause #339
  # fixed for the LOCAL reaper. We close the same gap for remote workers by resolving the
  # authoritative PR-merged state HERE on the trusted Windows orchestrator (gh is authenticated on
  # Windows; the Mac's gh token frequently expires, so we deliberately do NOT shell `gh` over SSH).
  # The confirmed-MERGED worktree paths are handed to the remote, which removes them under the same
  # dirty-check / agent-exclusion safety valves as classes 2-3.
  $dryFlag = if ($dry) { "1" } else { "0" }
  Get-EnabledMachines | Where-Object { $_.kind -eq "ssh" } | ForEach-Object {
    $m = $_

    # Refresh remote statuses first so crashed/SIGKILLed workers (tmux window gone) flip
    # running -> failed and become eligible for the terminal-status gate below.
    Sync-RemoteWorkerStatuses -Machine $m

    # Authoritative reap set (class 1): worker worktrees whose PR is MERGED. gh runs locally.
    $mergedWorktrees = New-Object System.Collections.Generic.List[string]
    foreach ($st in (Get-RemoteWorkerStates -Machine $m)) {
      if ($st.role -eq "worker" -and $st.prNumber -and $st.worktree -and
          $st.status -in @("completed", "failed", "timeout")) {
        $prState = (gh pr view $st.prNumber --json state --jq '.state' 2>$null)
        if ($prState -eq "MERGED") { $mergedWorktrees.Add([string]$st.worktree) }
      }
    }
    $mergedListText = (@($mergedWorktrees) | Sort-Object -Unique) -join "`n"

    $cmd = @"
cd $($m.remoteRepoPath) && \
git fetch origin && \
DRY=$dryFlag
# Confirmed-MERGED worker worktrees, resolved authoritatively on the Windows side (#335).
# Quoted heredoc => bash does not interpolate the paths; empty list => MERGED_WT="" (no match).
MERGED_WT=`$(cat <<'KT_MERGED_EOF'
$mergedListText
KT_MERGED_EOF
)
is_merged_wt() { printf '%s\n' "`$MERGED_WT" | grep -Fxq -- "`$1"; }
for wt in `$(git worktree list --porcelain | awk '/^worktree/ {print `$2}' | grep -v "$($m.remoteRepoPath)$"); do
  br=`$(git -C "`$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if is_merged_wt "`$wt" || [ "`$br" = "HEAD" ] || { [ -n "`$br" ] && git branch --merged main | grep -q "`$br"; }; then
    # Safety parity with the local reaper (#353): never reap a locked agent worktree,
    # and never force-remove a worktree with uncommitted changes (a concurrent session
    # may still have unsaved work there). Both only ever SKIP candidates -> strictly safer.
    case "`$wt" in */.claude/worktrees/*) echo "skip (agent worktree): `$wt"; continue;; esac
    if [ -n "`$(git -C "`$wt" status --porcelain 2>/dev/null)" ]; then
      echo "skip (dirty): `$wt"
      continue
    fi
    if [ "`$DRY" = "1" ]; then
      echo "would remove: `$wt"
    else
      echo "removing: `$wt"
      git worktree remove "`$wt" --force
      # GC the merged worker branch too (#376), mirroring the local reaper: a detached reviewer
      # (br=HEAD) has no branch, so skip it; otherwise the branch is MERGED here and safe to drop.
      if [ "`$br" != "HEAD" ] && [ -n "`$br" ]; then git branch -D "`$br" >/dev/null 2>&1 || true; fi
    fi
  fi
done
"@
    # Base64-wrap (#342): $cmd is a multi-line script. Passed raw it reaches the
    # remote as a single argv blob that the login shell (zsh on macOS) mis-tokenizes
    # ("unmatched \""). _Wrap-AsBase64Bash collapses it to a one-line
    # `echo <b64> | base64 -d | bash` so any newlines/quotes round-trip intact and
    # the payload runs under bash (not the login zsh), matching Start-RemoteWorker.
    $r = Invoke-SshCommand -Machine $m -Command (_Wrap-AsBase64Bash -Script $cmd) -TimeoutSec 30
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
