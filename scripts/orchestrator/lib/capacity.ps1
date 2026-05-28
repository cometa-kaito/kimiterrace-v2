<#
.SYNOPSIS
  Calculate parallel worker capacity for a single machine.

.DESCRIPTION
  Per-machine capacity calculation. Caller (orchestrator.ps1) iterates over
  config.machines and aggregates results.

  Decision rules (each is a hard ceiling):
    1. RAM:    free RAM minus reserve, divided by (ram_per_worker * safetyMargin)
    2. Disk:   (free disk - min_free_disk) / disk_per_worktree
    3. CPU:    if current load >= cpuLoadMaxPct, returns 0
    4. HardCap: workerHardCap (or reviewerHardCap) from machine config
    5. ActiveWorkers: subtract currently running workers on this machine

  Final = floor(min(1..4)) - (5), clamped to 0+.

.PARAMETER Probe
  Output object from probe.ps1 (local) or Invoke-RemoteProbe (remote).

.PARAMETER Machine
  Per-machine config object (one entry from config.machines.<name>).

.PARAMETER ActiveWorkers
  Count of currently running workers on this machine.

.PARAMETER Role
  "worker" or "reviewer" — selects appropriate hard cap.

.OUTPUTS
  PSCustomObject with: MaxConcurrent, RamLimited, DiskLimited, CpuBlocked,
  HardCapped, ActiveWorkers, Reasoning.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory)][PSCustomObject]$Probe,
  [Parameter(Mandatory)][PSCustomObject]$Machine,
  [int]$ActiveWorkers = 0,
  [ValidateSet("worker", "reviewer")][string]$Role = "worker"
)

$ErrorActionPreference = "Stop"

# If probe failed (remote unreachable), return 0 capacity with reason
if ($Probe.PSObject.Properties.Name -contains "Error") {
  return [PSCustomObject]@{
    MaxConcurrent = 0
    RamLimited    = 0
    DiskLimited   = 0
    CpuBlocked    = $false
    HardCapped    = 0
    ActiveWorkers = $ActiveWorkers
    Unreachable   = $true
    Reasoning     = @("Machine unreachable: $($Probe.Error)")
  }
}

$ramPerProc = $Machine.ramPerWorkerMb
$diskPerProc = $Machine.diskPerWorktreeMb
$reserve = $Machine.desktopReserveMb
$minFreeDisk = $Machine.minFreeDiskMb
$margin = $Machine.safetyMargin
$cpuMax = $Machine.cpuLoadMaxPct
$hardCap = if ($Role -eq "reviewer") { $Machine.reviewerHardCap } else { $Machine.workerHardCap }

# 1. RAM ceiling
$ramBudget = $Probe.FreeRamMb - $reserve
$ramSlots = if ($ramBudget -le 0) { 0 } else { [math]::Floor($ramBudget / ($ramPerProc * $margin)) }

# 2. Disk ceiling
$diskBudget = $Probe.FreeDiskMb - $minFreeDisk
$diskSlots = if ($diskBudget -le 0) { 0 } else { [math]::Floor($diskBudget / $diskPerProc) }

# 3. CPU blocker
$cpuBlocked = $Probe.CpuLoadPct -ge $cpuMax

# 4 & 5
$rawMax = [math]::Min([math]::Min($ramSlots, $diskSlots), $hardCap)
$available = [math]::Max(0, $rawMax - $ActiveWorkers)
if ($cpuBlocked) { $available = 0 }

$reasoning = @(
  "Role: $Role",
  "Free RAM: $($Probe.FreeRamMb) MB | reserve $reserve MB -> budget $ramBudget MB | per-proc $ramPerProc * $margin = $($ramPerProc * $margin) MB -> $ramSlots slots",
  "Free disk: $($Probe.FreeDiskMb) MB | headroom $minFreeDisk MB -> budget $diskBudget MB | per-worktree $diskPerProc MB -> $diskSlots slots",
  "CPU load: $($Probe.CpuLoadPct)% (threshold $cpuMax%) -> blocked=$cpuBlocked",
  "Hard cap ($Role): $hardCap",
  "Active ${Role}s on this machine: $ActiveWorkers",
  "Raw max = min(ram=$ramSlots, disk=$diskSlots, cap=$hardCap) = $rawMax",
  "Available = max(0, $rawMax - $ActiveWorkers) = $available" + $(if ($cpuBlocked) { " -> 0 (CPU blocked)" } else { "" })
)

[PSCustomObject]@{
  MaxConcurrent = $available
  RamLimited    = $ramSlots
  DiskLimited   = $diskSlots
  CpuBlocked    = $cpuBlocked
  HardCapped    = $hardCap
  ActiveWorkers = $ActiveWorkers
  Unreachable   = $false
  Reasoning     = $reasoning
}
