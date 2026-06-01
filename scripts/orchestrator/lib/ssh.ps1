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

# Homebrew bin paths (ARM Mac / Intel Mac / Linux) — prepended so bare `tmux`
# resolves under SSH non-interactive sessions where /opt/homebrew/bin is not
# in PATH by default.
$Script:RemotePathPrefix = 'export PATH=/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH; '

function _Encode-Utf8Base64 {
  # Base64-encode a string as UTF-8 bytes, normalizing CRLF → LF first.
  # Used to safely round-trip payloads (JSON, multi-line briefs, shell scripts)
  # through ssh.exe — Windows PowerShell 5.1 mangles embedded `"` and non-ASCII
  # bytes in native-command args, but base64 [A-Za-z0-9+/=] survives untouched.
  # CRLF normalization matters for shell scripts: bash treats `\r` as part of
  # the surrounding token (so `cd /foo\r` looks like a path that doesn't exist).
  param([Parameter(Mandatory)][string]$Text)
  $normalized = $Text -replace "`r`n", "`n"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
  return [Convert]::ToBase64String($bytes)
}

function _Wrap-AsBase64Bash {
  # Wrap a shell script payload so it can survive ssh.exe arg handling intact.
  # Returns a single-line command of the form:
  #   <PATH-prefix>echo BASE64 | base64 -d | bash
  # The wrapped payload may contain any chars (quotes, $vars, newlines, UTF-8);
  # only the base64 ciphertext is in the ssh arg, which round-trips cleanly.
  param([Parameter(Mandatory)][string]$Script)
  $b64 = _Encode-Utf8Base64 -Text $Script
  return "$Script:RemotePathPrefix" + "echo $b64 | base64 -d | bash"
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
  $cmd = "$Script:RemotePathPrefix" + "tmux has-session -t '$SessionName' 2>/dev/null && echo OK || echo MISSING"
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
  $cmd = "$Script:RemotePathPrefix" + "tmux list-windows -t '$SessionName' -F '#{window_name}' 2>/dev/null || true"
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
      # Worker no longer in tmux; mark as failed. jq filter base64-encoded
      # because raw `"` and `|` get mangled through ssh.exe arg handling.
      $jqFilter = '.status="failed" | .exitCode=-1'
      $jqB64 = _Encode-Utf8Base64 -Text $jqFilter
      $patchCmd = "tmp=`$(mktemp) && jq `"`$(echo $jqB64 | base64 -d)`" '$($s.StatePath)' > `$tmp && mv `$tmp '$($s.StatePath)'"
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

  # Distinct worktree path per role (#67 Med-2), symmetric with the local path.
  $wtPrefix = if ($Role -eq "reviewer") { "reviewer" } else { "worker" }
  $worktreePath = "$worktreeBase/$wtPrefix-issue-$Issue"
  $logPath = "$stateDir/logs/$WorkerId.log"
  $statePath = "$stateDir/workers/$WorkerId.json"
  $briefPath = "$stateDir/logs/$WorkerId.brief.md"

  # 1. Ensure state dir exists. mkdir args are ASCII paths, safe inline.
  $setupCmd = "mkdir -p $stateDir/workers $stateDir/logs $worktreeBase"
  Invoke-SshCommand -Machine $Machine -Command $setupCmd -TimeoutSec 10 | Out-Null

  # 2. Pre-create state JSON. Payload contains `"`, which ssh.exe arg handling
  # would strip — base64-wrap a full shell snippet so nothing leaks into args.
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
  $stateB64 = _Encode-Utf8Base64 -Text $statePayload
  $writeStateCmd = "echo $stateB64 | base64 -d > '$statePath'"
  Invoke-SshCommand -Machine $Machine -Command $writeStateCmd -TimeoutSec 10 | Out-Null

  # 3. Write brief content. Brief is UTF-8 Japanese; ssh.exe mojibake-corrupts
  # native non-ASCII args. base64 round-trip keeps bytes intact.
  $briefB64 = _Encode-Utf8Base64 -Text $BriefContent
  $writeBriefCmd = "echo $briefB64 | base64 -d > '$briefPath'"
  Invoke-SshCommand -Machine $Machine -Command $writeBriefCmd -TimeoutSec 10 | Out-Null

  # 4. Run worker-launcher.sh inside a tmux window.
  # CRITICAL: tmux session "workers" must be started from a Mac Terminal.app
  # (interactive shell) so it inherits Keychain access for the user's
  # subscription credentials. SSH-spawned processes cannot access the
  # locked Keychain otherwise. See README "Multi-Machine" section.
  $tmuxSession = $Machine.tmuxSession
  if (-not $tmuxSession) { $tmuxSession = "workers" }

  $launcher = "$repoPath/scripts/orchestrator/worker-launcher.sh"
  # Build the launcher invocation. Write it as a small driver script on the
  # remote side (base64 round-trip) and have tmux exec the script — avoids
  # nested-quoting hazards across PowerShell → ssh.exe → zsh → tmux → sh.
  $driverScript = @"
#!/bin/bash
export PATH=/opt/homebrew/bin:`$PATH
export NVM_DIR=`$HOME/.nvm
[ -s "`$NVM_DIR/nvm.sh" ] && . "`$NVM_DIR/nvm.sh"
cd '$repoPath'
exec bash '$launcher' '$Role' '$Issue' '$WorkerId' '$statePath' '$logPath' '$worktreePath' '$BranchName' '$briefPath'
"@
  $driverPath = "$stateDir/logs/$WorkerId.driver.sh"
  $driverB64 = _Encode-Utf8Base64 -Text $driverScript
  $writeDriverCmd = "echo $driverB64 | base64 -d > '$driverPath' && chmod +x '$driverPath'"
  Invoke-SshCommand -Machine $Machine -Command $writeDriverCmd -TimeoutSec 10 | Out-Null

  # tmux new-window -d (detached) -n <name> -t <session>: <command>
  # The shell-command arg is just `bash <driver-path>` — pure ASCII, safe.
  $tmuxCmd = "$Script:RemotePathPrefix" + "tmux new-window -d -n '$WorkerId' -t '${tmuxSession}:' 'bash $driverPath'"

  $result = Invoke-SshCommand -Machine $Machine -Command $tmuxCmd -TimeoutSec 15
  if ($result.ExitCode -ne 0) {
    throw "Remote worker spawn failed (is tmux session '$tmuxSession' running on $($Machine.host)?): $($result.Stderr)"
  }

  # PID is not directly observable from tmux new-window; we track via tmux
  # window name (= WorkerId) and state JSON instead. Mark pid = -1 sentinel
  # meaning "tracked via tmux window, not pid". Base64-wrap the jq filter so
  # the `"` chars survive ssh.exe.
  $jqFilter = '.pid = -1 | .tmuxWindow = "' + $WorkerId + '" | .tmuxSession = "' + $tmuxSession + '"'
  $patchScript = @"
tmp=`$(mktemp)
jq '$jqFilter' '$statePath' > "`$tmp" && mv "`$tmp" '$statePath'
"@
  $patchB64 = _Encode-Utf8Base64 -Text $patchScript
  $patchCmd = "echo $patchB64 | base64 -d | bash"
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
