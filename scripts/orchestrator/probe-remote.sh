#!/usr/bin/env bash
# Remote resource probe (run on macOS or Linux worker host).
# Emits JSON matching the schema of probe.ps1 on Windows.
#
# Used by orchestrator's Invoke-RemoteProbe via SSH:
#   ssh mac "bash ~/work/kimiterrace-v2/scripts/orchestrator/probe-remote.sh"

set -e

OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  # Apple Silicon: pages are 16K, Intel: 4K. vm_stat reports the page size in
  # its header on modern macOS. Fall back to 16384 (Apple Silicon default).
  PAGE_SIZE=$(vm_stat | head -1 | tr -dc '0-9' || true)
  if [ -z "$PAGE_SIZE" ] || [ "$PAGE_SIZE" -lt 1024 ]; then PAGE_SIZE=16384; fi

  FREE_PAGES=$(vm_stat | grep '^Pages free' | tr -dc '0-9')
  SPEC_PAGES=$(vm_stat | grep '^Pages speculative' | tr -dc '0-9')
  [ -z "$FREE_PAGES" ] && FREE_PAGES=0
  [ -z "$SPEC_PAGES" ] && SPEC_PAGES=0

  FREE_BYTES=$(( (FREE_PAGES + SPEC_PAGES) * PAGE_SIZE ))
  FREE_MB=$(( FREE_BYTES / 1024 / 1024 ))

  TOTAL_BYTES=$(sysctl -n hw.memsize)
  TOTAL_MB=$(( TOTAL_BYTES / 1024 / 1024 ))

  CORES=$(sysctl -n hw.logicalcpu)

  # vm.loadavg looks like "{ 1.23 0.45 0.67 }" — take the 1-minute value
  LOAD=$(sysctl -n vm.loadavg | sed 's/[{}]//g' | awk '{print $1}')
  CPU_PCT=$(printf "%.1f" "$(echo "scale=4; ($LOAD / $CORES) * 100" | bc)")

  DISK_FREE_KB=$(df -k "$HOME" | tail -1 | awk '{print $4}')
  DISK_FREE_MB=$(( DISK_FREE_KB / 1024 ))

elif [ "$OS" = "Linux" ]; then
  TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  FREE_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  CORES=$(nproc)
  LOAD=$(awk '{print $1}' /proc/loadavg)
  CPU_PCT=$(printf "%.1f" "$(echo "scale=4; ($LOAD / $CORES) * 100" | bc)")
  DISK_FREE_KB=$(df -k "$HOME" | tail -1 | awk '{print $4}')
  DISK_FREE_MB=$(( DISK_FREE_KB / 1024 ))

else
  printf '{"error":"unsupported OS: %s"}\n' "$OS"
  exit 1
fi

CLAUDE_COUNT=$(pgrep -fc 'claude' 2>/dev/null || echo 0)
NODE_COUNT=$(pgrep -fc 'node' 2>/dev/null || echo 0)

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
