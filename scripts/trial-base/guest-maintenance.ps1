# Guest half of scripts/build-trial-base.sh (TIF-98 follow-up): run clean-base's
# pending maintenance to completion, then disable only the maintenance triggers
# and Windows Update. Defender real-time protection stays ON; no exclusions are
# added. Every stage prints JSON or plain text that the host saves as evidence.
#
#   powershell -ExecutionPolicy Bypass -File trial-base-maintenance.ps1 -Stage <stage>
#
# Stages:
#   state       JSON snapshot of everything the maintenance changes (run before and after)
#   signatures  Defender signature update (needs the temporary egress window)
#   ngen        `ngen executeQueuedItems` for every installed .NET Framework ngen.exe
#   idle        start Automatic Maintenance and ProcessIdleTasks, wait until it is quiet
#   scan        Defender full scan, to completion
#   disable     maintenance triggers off, Windows Update off (policy + service)
#   check       exit 1 unless Defender real-time is on and there are no exclusions
param([Parameter(Mandatory = $true)]
      [ValidateSet('state', 'signatures', 'ngen', 'idle', 'scan', 'disable', 'check')] [string]$Stage)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$maintKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\Maintenance'
$wuPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'

# Windows PowerShell 5.1 turns a native command's stderr into an error record
# under `2>&1`, which $ErrorActionPreference = 'Stop' then throws on. Native
# tools (ngen, MSchedExe) are judged by their exit codes instead.
function Native([scriptblock]$b) {
  $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $b } finally { $ErrorActionPreference = $saved }
}

function NgenExes {
  Get-ChildItem 'C:\Windows\Microsoft.NET' -Directory -Filter 'Framework*' |
    ForEach-Object { Join-Path $_.FullName 'v4.0.30319\ngen.exe' } |
    Where-Object { Test-Path -LiteralPath $_ }
}

function RunningWindowsTasks {
  @(Get-ScheduledTask -TaskPath '\Microsoft\Windows\*' -ErrorAction SilentlyContinue |
    Where-Object State -eq 'Running' | ForEach-Object { $_.TaskPath + $_.TaskName })
}

function Iso($d) { if ($d) { ([datetime]$d).ToUniversalTime().ToString('o') } else { $null } }

if ($Stage -eq 'state') {
  $mp = Get-MpComputerStatus
  $pref = Get-MpPreference
  $os = Get-CimInstance Win32_OperatingSystem
  $tasks = @(Get-ScheduledTask -TaskPath '\Microsoft\Windows\*' -ErrorAction SilentlyContinue)
  $info = $tasks | ForEach-Object { $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue }
  $neverRun = @($info | Where-Object { -not $_.LastRunTime -or $_.LastRunTime.Year -lt 2000 }).Count
  $ngen = foreach ($n in NgenExes) {
    $out = (Native { & $n queue status 2>&1 } | Out-String).Trim()
    [ordered]@{ ngen = $n.Substring(11); queue_status = $out }
  }
  $mk = Get-ItemProperty -LiteralPath $maintKey -ErrorAction SilentlyContinue
  $wp = Get-ItemProperty -LiteralPath $wuPolicy -ErrorAction SilentlyContinue
  [ordered]@{
    taken_utc = (Get-Date).ToUniversalTime().ToString('o')
    uptime_s = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
    os_build = $os.BuildNumber
    defender = [ordered]@{
      am_service_enabled = $mp.AMServiceEnabled
      realtime_protection_enabled = $mp.RealTimeProtectionEnabled
      antivirus_enabled = $mp.AntivirusEnabled
      signature_version = $mp.AntivirusSignatureVersion
      signature_last_updated_utc = Iso $mp.AntivirusSignatureLastUpdated
      quick_scan_end_utc = Iso $mp.QuickScanEndTime
      full_scan_end_utc = Iso $mp.FullScanEndTime
      disable_realtime_monitoring_pref = $pref.DisableRealtimeMonitoring
      exclusion_path = @($pref.ExclusionPath | Where-Object { $_ })
      exclusion_process = @($pref.ExclusionProcess | Where-Object { $_ })
      exclusion_extension = @($pref.ExclusionExtension | Where-Object { $_ })
    }
    ngen = @($ngen)
    scheduled_tasks = [ordered]@{
      windows_tasks = $tasks.Count
      running = RunningWindowsTasks
      never_run = $neverRun
      disabled = @($tasks | Where-Object State -eq 'Disabled').Count
    }
    automatic_maintenance = [ordered]@{
      maintenance_disabled = $mk.MaintenanceDisabled
      last_start_raw = if ($mk.LastStartTime) { $mk.LastStartTime } else { $null }
    }
    windows_update = [ordered]@{
      wuauserv_start_type = (Get-Service wuauserv).StartType.ToString()
      wuauserv_status = (Get-Service wuauserv).Status.ToString()
      policy_no_auto_update = $wp.NoAutoUpdate
    }
  } | ConvertTo-Json -Depth 5
  exit 0
}

if ($Stage -eq 'signatures') {
  # Right after boot Windows may already be updating signatures by itself, and
  # Update-MpSignature then fails with HRESULT 0x80070652
  # (ERROR_INSTALL_ALREADY_RUNNING; seen 2026-11-26, run 1). Only for that
  # HRESULT: wait 60 s and retry, until an attempt succeeds or the signature
  # version changes (the other install finished), for at most 25 minutes in
  # total. At the deadline, fail closed (exit 1). Any other error fails at once,
  # as before. Defender itself is not touched: this only waits.
  $before = (Get-MpComputerStatus).AntivirusSignatureVersion
  $deadline = (Get-Date).AddMinutes(25)
  $attempt = 0
  while ($true) {
    $attempt++
    try { Update-MpSignature; break }
    catch {
      # -2147023278 is 0x80070652 as a signed Int32 (Exception.HResult).
      $busy = ($_.FullyQualifiedErrorId -like 'HRESULT 0x80070652,*') -or ($_.Exception.HResult -eq -2147023278)
      if (-not $busy) { throw }
      "signatures: attempt ${attempt}: another install is in progress (HRESULT 0x80070652)"
    }
    if ((Get-Date) -gt $deadline) { "signatures: FAIL still 0x80070652 after 25 min ($attempt attempts); version $before"; exit 1 }
    Start-Sleep -Seconds 60
    $now = (Get-MpComputerStatus).AntivirusSignatureVersion
    if ($now -ne $before) { "signatures: the other install moved the version to $now"; break }
  }
  $after = Get-MpComputerStatus
  "signatures: $before -> $($after.AntivirusSignatureVersion) (last updated $(Iso $after.AntivirusSignatureLastUpdated))"
  exit 0
}

if ($Stage -eq 'ngen') {
  $rc = 0
  foreach ($n in NgenExes) {
    "== $n executeQueuedItems"
    Native { & $n executeQueuedItems 2>&1 } | Out-String | Write-Output
    $code = $LASTEXITCODE
    "exit=$code"
    if ($code -ne 0) { $rc = 1 }
    "== $n queue status (after)"
    Native { & $n queue status 2>&1 } | Out-String | Write-Output
  }
  exit $rc
}

if ($Stage -eq 'idle') {
  # Automatic Maintenance on demand, then the idle-task queue. Done when no
  # \Microsoft\Windows task (except the two below) has been running and the
  # guest CPU has stayed low for 3 consecutive 30 s samples; give up (exit 1)
  # after 60 minutes.
  # Exactly three tasks are not counted, matched by full path (equality, no
  # wildcards). SystemSoundsService and CacheTask (lead ruling 2026-11-26
  # 05:37Z) run for the whole session: in build run 2 they were running in all
  # 115 samples and in the deadline line, and also 22-23 s after boot.
  # WDI\ResolutionHost (lead ruling 2026-11-26 20:3xZ, trial-base-v3): on a COLD
  # boot it ran in 85 of 103 samples through the 60 min deadline with the guest
  # otherwise idle (CPU 2-6%), and never appeared on the fast-booted v2 builds.
  # Unconfirmed explanation: the Diagnostic Policy Service resolving the
  # slow-boot event a ~134 s cold boot logs. All three are still logged in every
  # sample.
  $notCounted = @('\Microsoft\Windows\Multimedia\SystemSoundsService', '\Microsoft\Windows\Wininet\CacheTask', '\Microsoft\Windows\WDI\ResolutionHost')
  $msched = "$env:windir\System32\MSchedExe.exe"
  if (Test-Path -LiteralPath $msched) { Native { & $msched Start }; "idle: Automatic Maintenance started" } else { "idle: MSchedExe.exe not present; idle tasks only" }
  Native { & "$env:windir\System32\rundll32.exe" advapi32.dll,ProcessIdleTasks }
  $quiet = 0; $deadline = (Get-Date).AddMinutes(60)
  while ($quiet -lt 3) {
    if ((Get-Date) -gt $deadline) { "idle: not quiet after 60 min; running: $((RunningWindowsTasks) -join ', ')"; exit 1 }
    Start-Sleep -Seconds 30
    $running = RunningWindowsTasks
    $counted = @($running | Where-Object { $notCounted -notcontains $_ })
    $cpu = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average, 0)
    "idle: $(Get-Date -Format HH:mm:ss) cpu=$cpu% running=$($running.Count) counted=$($counted.Count) $($running -join ', ')"
    if ($counted.Count -eq 0 -and $cpu -lt 15) { $quiet++ } else { $quiet = 0 }
  }
  "idle: quiet for 3 samples"
  exit 0
}

if ($Stage -eq 'scan') {
  $t = Get-Date
  Start-MpScan -ScanType FullScan
  $mp = Get-MpComputerStatus
  "scan: full scan finished in $([int]((Get-Date) - $t).TotalSeconds)s; FullScanEndTime=$(Iso $mp.FullScanEndTime)"
  $threats = @(Get-MpThreatDetection -ErrorAction SilentlyContinue)
  "scan: threat detections on record: $($threats.Count)"
  exit 0
}

if ($Stage -eq 'disable') {
  # Automatic Maintenance off: the trigger that re-runs maintenance on idle.
  New-Item -Path $maintKey -Force | Out-Null
  Set-ItemProperty -LiteralPath $maintKey -Name MaintenanceDisabled -Value 1 -Type DWord
  # Windows Update off: policy, then the service. The guest has no internet
  # either way (TIF-275); this stops it from waking up to try.
  New-Item -Path $wuPolicy -Force | Out-Null
  Set-ItemProperty -LiteralPath $wuPolicy -Name NoAutoUpdate -Value 1 -Type DWord
  Stop-Service wuauserv -Force -ErrorAction SilentlyContinue
  Set-Service wuauserv -StartupType Disabled
  "disable: MaintenanceDisabled=1, AU NoAutoUpdate=1, wuauserv $((Get-Service wuauserv).StartType)"
  exit 0
}

if ($Stage -eq 'check') {
  $mp = Get-MpComputerStatus
  $pref = Get-MpPreference
  $ex = @($pref.ExclusionPath) + @($pref.ExclusionProcess) + @($pref.ExclusionExtension) | Where-Object { $_ }
  if (-not $mp.RealTimeProtectionEnabled -or $pref.DisableRealtimeMonitoring) { "check: FAIL Defender real-time protection is not on"; exit 1 }
  if (@($ex).Count -gt 0) { "check: FAIL Defender has exclusions: $($ex -join ', ')"; exit 1 }
  "check: Defender real-time on, no exclusions"
  exit 0
}
