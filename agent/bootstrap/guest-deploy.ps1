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

$pyExe = '"C:\Program Files\Python312-arm64\python.exe"'
$lines = @(
    "cd /d `"$agentDir`"",
    "start `"`" /min $pyExe -m myco_agent --host 127.0.0.1 --port 8765 --token-file `"$tokenPath`" --backend windows"
)
$cmd = ($lines -join "`r`n") + "`r`n"
Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII
taskkill /IM python.exe /F 2>$null | Out-Null
schtasks /End /TN 'MycoAgent' 2>$null | Out-Null
schtasks /Create /TN 'MycoAgent' /XML $xmlPath /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks create failed: $LASTEXITCODE" }
schtasks /Run /TN 'MycoAgent' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks run failed: $LASTEXITCODE" }
Write-Output 'MycoAgent task registered and started'
