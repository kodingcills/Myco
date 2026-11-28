# guest-hcu.ps1: install and verify Microsoft Hybrid Computer Use (HCU) in the trial base
# (TIF-734; docs/benchmark/hcu-shell-runbook.md section 1, item 3). Copied into the guest by
# scripts/build-trial-base.sh when MYCO_TRIAL_BASE_HCU_DIR is set. Kept in the snapshot as
# C:\myco\bin\myco-hcu.ps1 so the verify stage can be re-run later.
#
#   install  check every staged file against SHA256SUMS, move the binaries into C:\myco\bin,
#            and register the MycoHCU task: at myco's logon, in the interactive session
#            (session 1), run `computer-use.exe serve`. An SSH session is session 0 and cannot
#            see the desktop, so the harness reaches HCU through that daemon:
#            `C:\myco\bin\computer-use.exe mcp --attach <socket>`.
#   verify   wait for computer-use.exe in a session other than 0, then ask the daemon for its
#            status from this (session 0) shell. Prints the socket path on success, and the
#            instance markers `pid=` (that computer-use.exe) and `boot_utc=` (Windows' last boot,
#            Unix seconds) that a resume checks.
#   identity read-only: report whether -ExpectPid is still computer-use.exe in an interactive
#            session, and Windows' last boot time; for `MYCO_TRIAL_BASE_RESUME_FROM=5b`.
#
# Exit 0 ok, 1 failed. Prints no secret: there is none here.
param([Parameter(Mandatory)][ValidateSet('install', 'verify', 'identity')][string]$Stage,
      [string]$Staging = 'C:\myco\hcu-staging',
      [int]$ExpectPid = 0)
$ErrorActionPreference = 'Stop'
$bin = 'C:\myco\bin'
$exe = Join-Path $bin 'computer-use.exe'
$files = @('computer-use.exe', 'computer-use-windows-provider.exe', 'LICENSE', 'THIRD_PARTY_NOTICES.md')

if ($Stage -eq 'install') {
  $sums = @{}
  foreach ($line in Get-Content -LiteralPath (Join-Path $Staging 'SHA256SUMS')) {
    if ($line -match '^([0-9a-f]{64})\s+(\S+)$') { $sums[$Matches[2]] = $Matches[1] }
  }
  foreach ($f in $files) {
    if (-not $sums.ContainsKey($f)) { "install: FAIL $f is not in SHA256SUMS"; exit 1 }
    $h = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Staging $f)).Hash.ToLower()
    if ($h -ne $sums[$f]) { "install: FAIL $f sha256 $h, expected $($sums[$f])"; exit 1 }
    "install: $f sha256 ok $h"
  }
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $lic = Join-Path $bin 'hcu-licenses'
  New-Item -ItemType Directory -Force -Path $lic | Out-Null
  Copy-Item -LiteralPath (Join-Path $Staging 'computer-use.exe') -Destination $bin -Force
  Copy-Item -LiteralPath (Join-Path $Staging 'computer-use-windows-provider.exe') -Destination $bin -Force
  Copy-Item -LiteralPath (Join-Path $Staging 'LICENSE') -Destination $lic -Force
  Copy-Item -LiteralPath (Join-Path $Staging 'THIRD_PARTY_NOTICES.md') -Destination $lic -Force
  Copy-Item -LiteralPath (Join-Path $Staging 'SHA256SUMS') -Destination $lic -Force
  $version = (& $exe version | Out-String).Trim()
  "install: computer-use version $version"
  # At logon, in myco's interactive session; no password stored (Interactive logon type).
  $action = New-ScheduledTaskAction -Execute $exe -Argument 'serve --idle-timeout 8760h' -WorkingDirectory 'C:\myco'
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User 'myco'
  $principal = New-ScheduledTaskPrincipal -UserId 'myco' -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'MycoHCU' -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Force | Out-Null
  "install: MycoHCU task registered (at logon of myco, interactive session): $exe serve --idle-timeout 8760h"
  Remove-Item -LiteralPath $Staging -Recurse -Force
  "install: staging removed"
  exit 0
}

function BootUtc { [DateTimeOffset]::new((Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeSeconds() }

if ($Stage -eq 'identity') {
  $p = Get-Process -Id $ExpectPid -ErrorAction SilentlyContinue
  $alive = [int]($null -ne $p -and $p.ProcessName -eq 'computer-use' -and $p.SessionId -ne 0)
  "identity: pid=$ExpectPid alive=$alive session=$(if ($p) { $p.SessionId } else { 'none' }) boot_utc=$(BootUtc)"
  exit 0
}

# verify
$deadline = (Get-Date).AddSeconds(180)
$proc = $null
while ((Get-Date) -lt $deadline) {
  $proc = Get-Process -Name 'computer-use' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ne 0 } | Select-Object -First 1
  if ($proc) { break }
  Start-Sleep -Seconds 5
}
if (-not $proc) {
  $task = Get-ScheduledTask -TaskName 'MycoHCU' -ErrorAction SilentlyContinue
  "verify: FAIL no computer-use.exe in an interactive session after 180 s (MycoHCU task state: $(if ($task) { $task.State } else { 'missing' }))"
  exit 1
}
"verify: computer-use.exe pid $($proc.Id) session $($proc.SessionId)"
$status = (& $exe daemon status | Out-String).Trim()
if ($status -notmatch '"socket"') { "verify: FAIL daemon status: $status"; exit 1 }
$socket = ($status | ConvertFrom-Json).socket
"verify: daemon answers from session 0; socket $socket"
"socket=$socket"
"pid=$($proc.Id)"
"boot_utc=$(BootUtc)"
exit 0
