#!/usr/bin/env bash
# guest-boot-profile.sh: read-only profile of the guest's current boot (TIF-98).
#
# Prints JSON: Windows' own boot-phase timings (Diagnostics-Performance event
# 100) for the current boot and for the earliest boot on record, guest uptime,
# and the guest processes with the most CPU since boot plus over a 10 s window.
# It changes nothing on the guest. It does not take the VM lock (it is one
# read-only ssh session, like the runbook's §2 checks); run it only when
# `lsof /tmp/myco-win11.vm.lock || echo free` prints free, under the load gate.
#
# usage: guest-boot-profile.sh > profile.json
set -euo pipefail
VSSH=${MYCO_VSSH:-$HOME/VMs/myco-win11/scripts/vssh}

# -EncodedCommand (UTF-16LE base64), not `-Command -`: PowerShell runs stdin line
# by line and silently drops multi-line blocks such as the function below.
PS=$(cat <<'PS1'
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
function Phases($ev) {
  $x = [xml]$ev.ToXml(); $h = [ordered]@{}
  foreach ($d in $x.Event.EventData.Data) {
    if ($d.Name -match 'Time$' -and $d.Name -notmatch 'Start|End') { $h[$d.Name] = [int64]$d.'#text' }
    if ($d.Name -eq 'BootStartTime' -or $d.Name -eq 'SystemBootInstance') { $h[$d.Name] = $d.'#text' }
  }
  $h
}
$boots = @(Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Diagnostics-Performance/Operational'; Id=100} -ErrorAction SilentlyContinue)
$a = Get-Process | Select-Object Id, ProcessName, CPU
Start-Sleep -Seconds 10
$b = Get-Process | Select-Object Id, ProcessName, CPU
$window = foreach ($p in $b) {
  $o = $a | Where-Object Id -eq $p.Id
  if ($o -and $p.CPU -and $o.CPU) { [pscustomobject]@{ name = $p.ProcessName; cpu_s = [math]::Round($p.CPU - $o.CPU, 2) } }
}
[ordered]@{
  uptime_s = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
  boot_phases_ms_current = if ($boots.Count) { Phases $boots[0] } else { $null }
  boot_phases_ms_earliest = if ($boots.Count) { Phases $boots[-1] } else { $null }
  top_cpu_since_boot = @($b | Where-Object CPU | Sort-Object CPU -Descending | Select-Object -First 10 | ForEach-Object { [ordered]@{ name = $_.ProcessName; cpu_s = [math]::Round($_.CPU, 1) } })
  top_cpu_10s_window = @($window | Sort-Object cpu_s -Descending | Select-Object -First 8)
} | ConvertTo-Json -Depth 4
PS1
)
ENC=$(printf '%s' "$PS" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')
"$VSSH" "powershell -NoProfile -NonInteractive -EncodedCommand $ENC" | tr -d '\r' | sed -n '/^{/,$p'
