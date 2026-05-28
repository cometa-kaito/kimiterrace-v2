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

  $outFile = [System.IO.Path]::GetTempFileName()
  $errFile = [System.IO.Path]::GetTempFileName()
  try {
    $proc = Start-Process -FilePath "ssh" -ArgumentList $sshArgs `
              -NoNewWindow -PassThru `
              -RedirectStandardOutput $outFile `
              -RedirectStandardError $errFile
    $exited = $proc.WaitForExit($TimeoutSec * 1000)
    if (-not $exited) {
      $proc.Kill()
      throw "SSH command timed out after ${TimeoutSec}s: $Command"
    }
    $stdout = Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue
    $stderr = Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue
    [PSCustomObject]@{
      ExitCode = $proc.ExitCode
      Stdout   = $stdout
      Stderr   = $stderr
    }
  } finally {
    Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-RemoteProbe {
  <#
    Probe macOS/Linux host for resource snapshot.
    Returns same schema as local probe.ps1 for uniform handling.
  #>
  param([Parameter(Mandatory)][PSCustomObject]$Machine)

  # Single-shot remote script. macOS uses vm_stat / sysctl; Linux uses /proc.
  $remoteScript = @'
set -e
OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  PAGE_SIZE=$(vm_stat | awk '/page size/ {print $8}')
  if [ -z "$PAGE_SIZE" ]; then PAGE_SIZE=4096; fi
  FREE_PAGES=$(vm_stat | awk '/Pages free/ {gsub("[^0-9]","",$3); print $3}')
  SPECULATIVE=$(vm_stat | awk '/Pages speculative/ {gsub("[^0-9]","",$3); print $3}')
  if [ -z "$SPECULATIVE" ]; then SPECULATIVE=0; fi
  FREE_BYTES=$(( (FREE_PAGES + SPECULATIVE) * PAGE_SIZE ))
  FREE_MB=$(( FREE_BYTES / 1024 / 1024 ))
  TOTAL_BYTES=$(sysctl -n hw.memsize)
  TOTAL_MB=$(( TOTAL_BYTES / 1024 / 1024 ))
  CORES=$(sysctl -n hw.logicalcpu)
  LOAD=$(sysctl -n vm.loadavg | awk '{print $2}')
  CORE_F=$(echo "$CORES" | awk '{print $1+0}')
  CPU_PCT=$(awk -v l="$LOAD" -v c="$CORE_F" 'BEGIN{printf "%.1f", (l/c)*100}')
  DISK_FREE_KB=$(df -k ~ | awk 'NR==2 {print $4}')
  DISK_FREE_MB=$(( DISK_FREE_KB / 1024 ))
elif [ "$OS" = "Linux" ]; then
  TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  FREE_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  CORES=$(nproc)
  LOAD=$(awk '{print $1}' /proc/loadavg)
  CPU_PCT=$(awk -v l="$LOAD" -v c="$CORES" 'BEGIN{printf "%.1f", (l/c)*100}')
  DISK_FREE_KB=$(df -k ~ | awk 'NR==2 {print $4}')
  DISK_FREE_MB=$(( DISK_FREE_KB / 1024 ))
else
  echo "{\"error\":\"unsupported OS: $OS\"}"
  exit 1
fi

CLAUDE_COUNT=$(pgrep -f 'claude' 2>/dev/null | wc -l | tr -d ' ')
NODE_COUNT=$(pgrep -f 'node' 2>/dev/null | wc -l | tr -d ' ')

cat <<JSON
{
  "Timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "TotalRamMb": $TOTAL_MB,
  "FreeRamMb": $FREE_MB,
  "FreeDiskMb": $DISK_FREE_MB,
  "CpuLogicalCores": $CORES,
  "CpuLoadPct": $CPU_PCT,
  "ClaudeProcessCount": $CLAUDE_COUNT,
  "NodeProcessCount": $NODE_COUNT
}
JSON
'@

  $result = Invoke-SshCommand -Machine $Machine -Command $remoteScript -TimeoutSec 15
  if ($result.ExitCode -ne 0) {
    return [PSCustomObject]@{
      Error  = "Remote probe failed (exit $($result.ExitCode))"
      Stderr = $result.Stderr.Trim()
    }
  }
  try {
    $obj = $result.Stdout | ConvertFrom-Json
    return $obj
  } catch {
    return [PSCustomObject]@{
      Error  = "Failed to parse remote probe output"
      Raw    = $result.Stdout
      Stderr = $result.Stderr.Trim()
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
    try { $blob | ConvertFrom-Json } catch { }
  }
  if ($StatusFilter -ne "*") {
    $states = $states | Where-Object { $_.status -eq $StatusFilter }
  }
  return @($states)
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

  # 4. Run worker-launcher.sh with nohup
  $launcher = "$repoPath/scripts/orchestrator/worker-launcher.sh"
  $launchCmd = @"
cd $repoPath && \
nohup bash $launcher $Role $Issue $WorkerId $statePath $logPath $worktreePath $BranchName $briefPath \
  > /dev/null 2>&1 &
echo `$!
"@
  $result = Invoke-SshCommand -Machine $Machine -Command $launchCmd -TimeoutSec 15
  if ($result.ExitCode -ne 0) {
    throw "Remote worker spawn failed: $($result.Stderr)"
  }
  $remotePid = $result.Stdout.Trim()

  # 5. Update state with PID via jq (Mac setup script installs jq)
  $jqArg = "--arg p $remotePid"
  $jqExpr = "'.pid=(`$p|tonumber)'"
  $patchCmd = "tmp=`$(mktemp) && jq $jqArg $jqExpr $statePath > `$tmp && mv `$tmp $statePath"
  Invoke-SshCommand -Machine $Machine -Command $patchCmd -TimeoutSec 10 | Out-Null

  [PSCustomObject]@{
    Id          = $WorkerId
    RemoteHost  = $Machine.host
    RemotePid   = $remotePid
    StatePath   = $statePath
    LogPath     = $logPath
    Worktree    = $worktreePath
    BranchName  = $BranchName
  }
}
