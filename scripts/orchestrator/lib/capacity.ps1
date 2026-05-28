<#
.SYNOPSIS
  Calculate how many parallel Worker / Reviewer Claude processes can be
  safely spawned given current machine resources and orchestrator config.

.DESCRIPTION
  Decision rules (each is a hard ceiling):
    1. RAM:    free RAM minus desktop reserve, divided by (ram_per_worker * safetyMargin)
    2. Disk:   (free disk - min_free_disk_headroom) / disk_per_worktree
    3. CPU:    if current load >= cpuLoadMaxPct, returns 0 (don't spawn now)
    4. HardCap: workerHardCap from config (absolute upper bound)
    5. ActiveWorkers: subtract currently running workers from State store

  The final answer is the floor of (1..4) minus (5).

.PARAMETER Probe
  Output object from probe.ps1. If omitted, probe is called.

.PARAMETER ConfigPath
  Path to config.json. Defaults to ../config.json relative to this script.

.PARAMETER ActiveWorkers
  Count of currently running workers (from State). Default 0.

.PARAMETER Role
  "worker" or "reviewer". Selects the appropriate hard cap and per-process
  resource estimate from config.

.OUTPUTS
  PSCustomObject with: MaxConcurrent, RamLimited, DiskLimited, CpuBlocked,
  HardCapped, ActiveWorkers, Reasoning.
#>

[CmdletBinding()]
param(
  [PSCustomObject]$Probe,
  [string]$ConfigPath = "$PSScriptRoot/../config.json",
  [int]$ActiveWorkers = 0,
  [ValidateSet("worker", "reviewer")]
  [string]$Role = "worker"
)

$ErrorActionPreference = "Stop"

if (-not $Probe) {
  $Probe = & "$PSScriptRoot/probe.ps1"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

# Per-role per-process resource estimates
$ramPerProc = $config.ramPerWorkerMb
$diskPerProc = $config.diskPerWorktreeMb
$hardCap = if ($Role -eq "reviewer") { $config.reviewerHardCap } else { $config.workerHardCap }

# 1. RAM ceiling
$ramBudget = $Probe.FreeRamMb - $config.desktopReserveMb
$ramSlots = if ($ramBudget -le 0) {
  0
} else {
  [math]::Floor($ramBudget / ($ramPerProc * $config.safetyMargin))
}

# 2. Disk ceiling
$diskBudget = $Probe.FreeDiskMb - $config.minFreeDiskMb
$diskSlots = if ($diskBudget -le 0) {
  0
} else {
  [math]::Floor($diskBudget / $diskPerProc)
}

# 3. CPU blocker
$cpuBlocked = $Probe.CpuLoadPct -ge $config.cpuLoadMaxPct

# 4. Hard cap

# 5. Subtract active
$rawMax = [math]::Min([math]::Min($ramSlots, $diskSlots), $hardCap)
$available = [math]::Max(0, $rawMax - $ActiveWorkers)
if ($cpuBlocked) { $available = 0 }

# Build human-readable reasoning
$reasoning = New-Object System.Collections.Generic.List[string]
$reasoning.Add("Role: $Role")
$reasoning.Add("Free RAM: $($Probe.FreeRamMb) MB | reserved $($config.desktopReserveMb) MB -> budget $ramBudget MB | per-proc $ramPerProc * $($config.safetyMargin) = $($ramPerProc * $config.safetyMargin) MB -> ${ramSlots} slots")
$reasoning.Add("Free disk: $($Probe.FreeDiskMb) MB | headroom $($config.minFreeDiskMb) MB -> budget $diskBudget MB | per-worktree $diskPerProc MB -> ${diskSlots} slots")
$reasoning.Add("CPU load: $($Probe.CpuLoadPct)% (threshold $($config.cpuLoadMaxPct)%) -> blocked=$cpuBlocked")
$reasoning.Add("Hard cap ($Role): $hardCap")
$reasoning.Add("Active $($Role)s: $ActiveWorkers")
$reasoning.Add("Raw max = min(ram=$ramSlots, disk=$diskSlots, cap=$hardCap) = $rawMax")
$reasoning.Add("Available = max(0, $rawMax - $ActiveWorkers) = $available" + $(if ($cpuBlocked) { " -> 0 (CPU blocked)" } else { "" }))

[PSCustomObject]@{
  MaxConcurrent = $available
  RamLimited    = $ramSlots
  DiskLimited   = $diskSlots
  CpuBlocked    = $cpuBlocked
  HardCapped    = $hardCap
  ActiveWorkers = $ActiveWorkers
  Reasoning     = $reasoning.ToArray()
}
