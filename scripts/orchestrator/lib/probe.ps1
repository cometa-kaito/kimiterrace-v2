<#
.SYNOPSIS
  Snapshot current machine resources for orchestrator capacity planning.

.OUTPUTS
  PSCustomObject with: TotalRamMb, FreeRamMb, FreeDiskMb, CpuLogicalCores,
  CpuLoadPct, ClaudeProcessCount, ClaudeProcessRamMb, NodeProcessRamMb.

.NOTES
  Read-only. Safe to invoke at any time.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_ComputerSystem
$disk = Get-PSDrive C

# CPU load: 1-second sample
$cpuLoad = (Get-Counter "\Processor(_Total)\% Processor Time" `
              -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue
            ).CounterSamples.CookedValue
if ($null -eq $cpuLoad) { $cpuLoad = 0 }

# Process accounting
$claudeProcs = @(Get-Process -Name claude -ErrorAction SilentlyContinue)
$nodeProcs = @(Get-Process -Name node -ErrorAction SilentlyContinue)

$claudeRam = if ($claudeProcs.Count -gt 0) {
  ($claudeProcs | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB
} else { 0 }

$nodeRam = if ($nodeProcs.Count -gt 0) {
  ($nodeProcs | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB
} else { 0 }

[PSCustomObject]@{
  Timestamp           = (Get-Date).ToString("o")
  TotalRamMb          = [math]::Round($os.TotalVisibleMemorySize / 1KB, 0)
  FreeRamMb           = [math]::Round($os.FreePhysicalMemory / 1KB, 0)
  FreeDiskMb          = [math]::Round($disk.Free / 1MB, 0)
  CpuLogicalCores     = $cpu.NumberOfLogicalProcessors
  CpuLoadPct          = [math]::Round($cpuLoad, 1)
  ClaudeProcessCount  = $claudeProcs.Count
  ClaudeProcessRamMb  = [math]::Round($claudeRam, 0)
  NodeProcessRamMb    = [math]::Round($nodeRam, 0)
}
