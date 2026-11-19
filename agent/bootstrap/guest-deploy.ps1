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

# The agent MUST run in the logged-on user's desktop session: a session-0
# process cannot see windows, so UIA would silently observe nothing. A bare
# `schtasks /Run` of an InteractiveToken task lands in session 0 when started
# from an SSH context (verified on the VM), so we go through
# run-interactive.ps1, which registers a per-launch Interactive task and
# provably yields session 1. The wrapper keeps the task name stable so the
# LogonTrigger path still works for reboot recovery.
$pyExe = 'C:\Program Files\LibreOffice\program\python.exe'
$lines = @(
    "cd /d `"$agentDir`"",
    "`"C:\myco\bin\run-interactive.ps1`"`" -Exe `"$pyExe`" -ArgList `"-m myco_agent --host 127.0.0.1 --port 8765 --token-file $tokenPath --backend windows`" -Name myco-agent-interactive"
)
$cmd = ($lines -join "`r`n") + "`r`n"
Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII
try { taskkill /IM python.exe /F 2>$null | Out-Null } catch { }  # no python.exe on first deploy is fine
try { schtasks /End /TN 'MycoAgent' 2>$null | Out-Null } catch { }
schtasks /Create /TN 'MycoAgent' /XML $xmlPath /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks create failed: $LASTEXITCODE" }
schtasks /Run /TN 'MycoAgent' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks run failed: $LASTEXITCODE" }
Write-Output 'MycoAgent task registered and started'
