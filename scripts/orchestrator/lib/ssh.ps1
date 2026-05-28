<#
.SYNOPSIS
  SSH helpers for the orchestrator to talk to remote worker machines.

.DESCRIPTION
  Provides:
    - Test-SshConnection: probe reachability of a remote machine
    - Invoke-SshCommand: run a one-shot command, return stdout
    - Invoke-RemoteProbe: collect CPU/RAM/disk metrics from a Mac/Linux host
    - Get-RemoteWorkerStates: pull state JSONs from remote host
    - Start-RemoteWorker: spawn worker-launcher.sh over SSH (non-blocking)

  All helpers assume key-based SSH (no password prompts).
  Remote shell is assumed to be bash or zsh.
#>

function _Resolve-SshKey {
  param([string]$KeyPath)
  if (-not $KeyPath) { return $null }
  if ($KeyPath -like "~*") { $KeyPath = $KeyPath -replace "^~", $env:USERPROFILE }
  if (Test-Path $KeyPath) { return $KeyPath }
  return $null
}

function _Build-SshArgs {
  param(
    [Parameter(Mandatory)][PSCustomObject]$Machine,
    [switch]$Quiet
  )
  $sshKey = _Resolve-SshKey $Machine.sshKey
  $args = New-Object System.Collections.Generic.List[string]
  if ($sshKey) { $args.Add("-i"); $args.Add($sshKey) }
  if ($Machine.sshPort -and $Machine.sshPort -ne 22) {
    $args.Add("-p"); $args.Add($Machine.sshPort.ToString())
  }
  $args.Add("-o"); $args.Add("BatchMode=yes")
  $args.Add("-o"); $args.Add("ConnectTimeout=5")
  $args.Add("-o"); $args.Add("ServerAliveInterval=30")
  $args.Add("-o"); $args.Add("StrictHostKeyChecking=accept-new")
  if ($Quiet) { $args.Add("-q") }
  $args.Add("$($Machine.user)@$($Machine.host)")
  return $args.ToArray()
}

function Test-SshConnection {
  param([Parameter(Mandatory)][PSCustomObject]$Machine)
  $sshArgs = _Build-SshArgs -Machine $Machine -Quiet
  $sshArgs += "exit 0"
  $proc = Start-Process -FilePath "ssh" -ArgumentList $sshArgs `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput ([System.IO.Path]::GetTempFileName()) `
            -RedirectStandardError  ([System.IO.Path]::GetTempFileName())
  return $proc.ExitCode -eq 0
}

function Invoke-SshCommand {
  param(
    [Parameter(Mandatory)][PSCustomObject]$Machine,
    [Parameter(Mandatory)][string]$Command,
    [int]$TimeoutSec = 30
  )
  $sshArgs = _Build-SshArgs -Machine $Machine
  $sshArgs += $Command

  $errFile = [System.IO.Path]::GetTempFileName()
  try {
    $stdout = & ssh @sshArgs 2>$errFile
    $exitCode = $LASTEXITCODE
    $stderr = Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue
    if ($null -eq $stdout) { $stdout = "" }
    if ($stdout -is [array]) { $stdout = $stdout -join "`n" }
    [PSCustomObject]@{
      ExitCode = $exitCode
      Stdout   = $stdout
      Stderr   = $stderr
    }
  } finally {
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-RemoteProbe {
  <#
    Probe macOS/Linux host for resource snapshot.
    Returns same schema as local probe.ps1 for uniform handling.

    Implementation: invokes scripts/orchestrator/probe-remote.sh on the
    remote host (the script must be checked into the repo at that path).
    This avoids SSH quote-escaping hazards with inline scripts.
  #>
  param([Parameter(Mandatory)][PSCustomObject]$Machine)

  $repoPath = $Machine.remoteRepoPath
  $probeCmd = "bash $repoPath/scripts/orchestrator/probe-remote.sh"

  $result = Invoke-SshCommand -Machine $Machine -Command $probeCmd -TimeoutSec 15
  if ($result.ExitCode -ne 0) {
    return [PSCustomObject]@{
      Error  = "Remote probe failed (exit $($result.ExitCode))"
      Stderr = $(if ($result.Stderr) { $result.Stderr.Trim() } else { "" })
    }
  }
  try {
    $obj = $result.Stdout | ConvertFrom-Json
    return $obj
  } catch {
    return [PSCustomObject]@{
      Error  = "Failed to parse remote probe output"
      Raw    = $result.Stdout
      Stderr = $(if ($result.Stderr) { $result.Stderr.Trim() } else { "" })
    }
  }
}

function Get-RemoteWorkerStates {
  param(
    [Parameter(Mandatory)][PSCustomObject]$Machine,
    [string]$StatusFilter = "*"
  )
  $stateDir = $Machine.remoteStateDir
  if (-not $stateDir) { $stateDir = '$HOME/.kimiterrace-orchestrator' }
  $cmd = "for f in $stateDir/workers/*.json; do [ -f `"`$f`" ] && cat `"`$f`" && echo '---STATE-SEP---'; done 2>/dev/null"
  $result = Invoke-SshCommand -Machine $Machine -Command $cmd -TimeoutSec 10
  if ($result.ExitCode -ne 0) { return @() }
  $blobs = $result.Stdout -split '---STATE-SEP---' | Where-Object { $_.Trim() -ne "" }
  $states = foreach ($blob in $blobs) {
    try {
      $s = $blob | ConvertFrom-Json
      # Augment with StatePath for later updates
      $s | Add-Member -NotePropertyName StatePath -NotePropertyValue "$stateDir/workers/$($s.id).json" -Force
      $s
    } catch { }
  }
  if ($StatusFilter -ne "*") {
    $states = $states | Where-Object { $_.status -eq $StatusFilter }
  }
  return @($states)
}

function Test-RemoteTmuxSession {
  <#
    Returns $true if the named tmux session exists on the remote host.
    The orchestrator depends on this session being started from a Mac
    Terminal.app (so it has Keychain access for claude/gh credentials).
  #>
  param(
    [Parameter(Mandatory)][PSCustomObject]$Machine,
    [string]$SessionName = "workers"
  )
  $cmd = "tmux has-session -t '$SessionName' 2>/dev/null && echo OK || echo MISSING"
  $r = Invoke-SshCommand -Machine $Machine -Command $cmd -TimeoutSec 5
  return ($r.ExitCode -eq 0 -and $r.Stdout.Trim() -eq "OK")
}

function Get-RemoteTmuxWindows {
  <#
    Lists active tmux window names in the workers session.
    Used to detect which workers are still alive (window exists = process alive).
  #>
  param(
    [Parameter(Mandatory)][PSCustomObject]$Machine,
    [string]$SessionName = "workers"
  )
  $cmd = "tmux list-windows -t '$SessionName' -F '#{window_name}' 2>/dev/null || true"
  $r = Invoke-SshCommand -Machine $Machine -Command $cmd -TimeoutSec 5
  if ($r.ExitCode -ne 0) { return @() }
  return @($r.Stdout -split "`n" | Where-Object { $_.Trim() -ne "" })
}

function Sync-RemoteWorkerStatuses {
  <#
    For each "running" remote worker, check if its tmux window still exists.
    If window is gone but state says "running", mark as "failed" (orphan).
    The launcher's trap should update state on clean exit; this catches crashes.
  #>
  param([Parameter(Mandatory)][PSCustomObject]$Machine)

  $running = Get-RemoteWorkerStates -Machine $Machine -StatusFilter "running"
  if ($running.Count -eq 0) { return }

  $session = $Machine.tmuxSession
  if (-not $session) { $session = "workers" }
  $aliveWindows = Get-RemoteTmuxWindows -Machine $Machine -SessionName $session

  foreach ($s in $running) {
    $winName = if ($s.tmuxWindow) { $s.tmuxWindow } else { $s.id }
    if ($aliveWindows -notcontains $winName) {
      # Worker no longer in tmux; mark as failed (launcher's trap should have
      # updated it; if we get here, it crashed without running the trap)
      $patchCmd = "tmp=`$(mktemp) && jq '.status=`"failed`" | .exitCode=-1' '$($s.StatePath)' > `$tmp && mv `$tmp '$($s.StatePath)'"
      Invoke-SshCommand -Machine $Machine -Command $patchCmd -TimeoutSec 5 | Out-Null
    }
  }
}

function Start-RemoteWorker {
  <#
    Spawn a worker-launcher.sh invocation on the remote host. Non-blocking.
    Uses nohup so the worker survives SSH disconnect.
  #>
  param(
    [Parameter(Mandatory)][PSCustomObject]$Machine,
    [Parameter(Mandatory)][string]$Role,
    [Parameter(Mandatory)][int]$Issue,
    [Parameter(Mandatory)][string]$WorkerId,
    [Parameter(Mandatory)][string]$BranchName,
    [Parameter(Mandatory)][string]$BriefContent
  )

  $repoPath = $Machine.remoteRepoPath
  if (-not $repoPath) { throw "Machine config missing remoteRepoPath: $($Machine.host)" }

  $stateDir = $Machine.remoteStateDir
  if (-not $stateDir) { $stateDir = '$HOME/.kimiterrace-orchestrator' }

  $worktreeBase = $Machine.worktreeBaseDir
  if (-not $worktreeBase) { $worktreeBase = '$HOME/work/.kimiterrace-workers' }

  $worktreePath = "$worktreeBase/worker-issue-$Issue"
  $logPath = "$stateDir/logs/$WorkerId.log"
  $statePath = "$stateDir/workers/$WorkerId.json"
  $briefPath = "$stateDir/logs/$WorkerId.brief.md"

  # 1. Ensure state dir exists, write brief file
  $setupCmd = "mkdir -p $stateDir/workers $stateDir/logs $worktreeBase"
  Invoke-SshCommand -Machine $Machine -Command $setupCmd -TimeoutSec 10 | Out-Null

  # 2. Pre-create state JSON (status=running, pid=0 - will be set by launcher)
  $statePayload = @{
    id = $WorkerId
    role = $Role
    pid = 0
    issue = $Issue
    branch = $BranchName
    worktree = $worktreePath
    logPath = $logPath
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    status = "running"
    prNumber = $null
    exitCode = $null
    machine = $Machine.host
  } | ConvertTo-Json -Compress -Depth 5
  $writeStateCmd = "cat > $statePath <<'STATE_EOF'`n$statePayload`nSTATE_EOF"
  Invoke-SshCommand -Machine $Machine -Command $writeStateCmd -TimeoutSec 10 | Out-Null

  # 3. Write brief content via heredoc (escape single quotes carefully)
  $briefEscaped = $BriefContent -replace "'", "'\''"
  $writeBriefCmd = "cat > $briefPath <<'BRIEF_EOF'`n$BriefContent`nBRIEF_EOF"
  Invoke-SshCommand -Machine $Machine -Command $writeBriefCmd -TimeoutSec 10 | Out-Null

  # 4. Run worker-launcher.sh inside a tmux window.
  # CRITICAL: tmux session "workers" must be started from a Mac Terminal.app
  # (interactive shell) so it inherits Keychain access for the user's
  # subscription credentials. SSH-spawned processes cannot access the
  # locked Keychain otherwise. See README "Multi-Machine" section.
  $tmuxSession = $Machine.tmuxSession
  if (-not $tmuxSession) { $tmuxSession = "workers" }

  $launcher = "$repoPath/scripts/orchestrator/worker-launcher.sh"
  # Build the inner shell command: load Node/PATH, run launcher
  $innerCmd = "export PATH=/opt/homebrew/bin:\`$PATH; export NVM_DIR=\`$HOME/.nvm; [ -s \`$NVM_DIR/nvm.sh ] && . \`$NVM_DIR/nvm.sh; cd $repoPath && bash $launcher $Role $Issue $WorkerId $statePath $logPath $worktreePath $BranchName $briefPath"
  # tmux new-window -d (detached) -n <name> -t <session>: <command>
  $tmuxCmd = "tmux new-window -d -n '$WorkerId' -t '${tmuxSession}:' `"$innerCmd`""

  $result = Invoke-SshCommand -Machine $Machine -Command $tmuxCmd -TimeoutSec 15
  if ($result.ExitCode -ne 0) {
    throw "Remote worker spawn failed (is tmux session '$tmuxSession' running on $($Machine.host)?): $($result.Stderr)"
  }

  # PID is not directly observable from tmux new-window; we track via tmux
  # window name (= WorkerId) and state JSON instead. Mark pid = -1 sentinel
  # meaning "tracked via tmux window, not pid".
  $patchCmd = "tmp=`$(mktemp) && jq '.pid=-1 | .tmuxWindow=`"$WorkerId`" | .tmuxSession=`"$tmuxSession`"' $statePath > `$tmp && mv `$tmp $statePath"
  Invoke-SshCommand -Machine $Machine -Command $patchCmd -TimeoutSec 10 | Out-Null

  [PSCustomObject]@{
    Id           = $WorkerId
    RemoteHost   = $Machine.host
    TmuxSession  = $tmuxSession
    TmuxWindow   = $WorkerId
    StatePath    = $statePath
    LogPath      = $logPath
    Worktree     = $worktreePath
    BranchName   = $BranchName
  }
}
