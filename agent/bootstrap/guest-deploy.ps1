# Guest-side half of deploy-to-vm.sh. Run over SSH (session 0 is fine):
#   powershell -ExecutionPolicy Bypass -File guest-deploy.ps1 -Stage prepare
#   powershell -ExecutionPolicy Bypass -File guest-deploy.ps1 -Stage register
# Keeps PowerShell quoting out of the bash script.
param([Parameter(Mandatory = $true)][ValidateSet('prepare', 'register')] [string]$Stage)

$ErrorActionPreference = 'Stop'
$agentDir = 'C:\Program Files\Myco\agent'
$tokenPath = 'C:\ProgramData\Myco\agent.token'

if ($Stage -eq 'prepare') {
    New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path $tokenPath) | Out-Null
    Write-Output "prepared $agentDir and $(Split-Path $tokenPath)"
    exit 0
}

# register
$xmlPath = Join-Path $agentDir 'bootstrap\MycoAgent.xml'
$cmdPath = Join-Path $agentDir 'run-agent.cmd'
if (-not (Test-Path $xmlPath)) { throw "missing $xmlPath" }
if (-not (Test-Path $tokenPath)) { throw "missing $tokenPath" }

# pyuno (uno.py/pyuno.pyd) is built against LibreOffice's bundled Python ABI;
# the system 3.12 interpreter cannot import it, so the agent runs under LO's
# python.exe. It must ALSO run on the interactive desktop: a `schtasks /Run`
# of an InteractiveToken task issued from an SSH (session-0) context lands the
# agent in session 0, where UIA has no window station and observes nothing
# (verified on the VM: session_id 0 vs 1). run-interactive.ps1 registers a
# per-launch task with an Interactive principal and yields session 1.
$pyExe = 'C:\Program Files\LibreOffice\program\python.exe'
# No `start`: the task must stay attached to a live child. `start` returns
# immediately, the task completes, and Windows tears down the process tree,
# so the agent dies seconds after launch (observed: task Ready, no listener).
$lines = @(
    "cd /d `"$agentDir`"",
    "powershell -NoProfile -ExecutionPolicy Bypass -File `"C:\myco\bin\run-interactive.ps1`" -Exe `"$pyExe`" -ArgList `"-m myco_agent --host 127.0.0.1 --port 8765 --token-file $tokenPath --backend windows`" -Name myco-agent -WorkDir `"$agentDir`""
)
$cmd = ($lines -join "`r`n") + "`r`n"
Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII
try { taskkill /IM python.exe /F 2>$null | Out-Null } catch { }  # no python.exe on first deploy is fine
try { schtasks /End /TN 'MycoAgent' 2>$null | Out-Null } catch { }
# pywin32/comtypes/uiautomation live in LO's Python site-packages: install once
# per deploy (idempotent) or session_info/uia ops fail with ModuleNotFoundError.
& $pyExe -m pip install --quiet --no-warn-script-location pywin32 comtypes uiautomation
if ($LASTEXITCODE -ne 0) { throw "pip install into LO python failed: $LASTEXITCODE" }
schtasks /Create /TN 'MycoAgent' /XML $xmlPath /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks create failed: $LASTEXITCODE" }
# Run through the launcher, NOT `schtasks /Run MycoAgent`: an InteractiveToken
# task started from this SSH (session-0) context lands the agent in session 0,
# where UIA has no window station and observes nothing (verified: session_id
# 0 vs 1). The registered MycoAgent task remains for logon/reboot recovery.
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\myco\bin\run-interactive.ps1' `
    -Exe $pyExe `
    -ArgList '-m myco_agent --host 127.0.0.1 --port 8765 --token-file C:\ProgramData\Myco\agent.token --backend windows' `
    -Name 'myco-agent' -WorkDir $agentDir
if ($LASTEXITCODE -ne 0) { throw "interactive launch failed: $LASTEXITCODE" }
Write-Output 'MycoAgent task registered; agent launched in the interactive session'
