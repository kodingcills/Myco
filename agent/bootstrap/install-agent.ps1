# Registers the MycoAgent scheduled task (InteractiveToken, no stored password)
# and starts the agent in the myco interactive session.
#
# Run from an elevated SSH session on the VM:
#   powershell -ExecutionPolicy Bypass -File install-agent.ps1
#
# Prerequisites (from provisioning):
#   - agent tree at  C:\Program Files\Myco\agent
#   - token file at   C:\ProgramData\Myco\agent.token  (ACL: myco only)

$ErrorActionPreference = 'Stop'

$ErrorActionPreference = 'Stop'
$agentDir = 'C:\Program Files\Myco\agent'
$xmlPath = Join-Path $agentDir 'bootstrap\MycoAgent.xml'
$cmdPath = Join-Path $agentDir 'run-agent.cmd'
$tokenPath = 'C:\ProgramData\Myco\agent.token'

if (-not (Test-Path $xmlPath)) { throw "missing $xmlPath" }
if (-not (Test-Path $tokenPath)) { throw "missing $tokenPath" }

$cmd = "@`r`npython -m myco_agent --host 127.0.0.1 --port 8765 --token-file $tokenPath`r`n@"
Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII

schtasks /Create /TN "MycoAgent" /XML $xmlPath /F
if ($LASTEXITCODE -ne 0) { throw "schtasks create failed: $LASTEXITCODE" }

schtasks /Run /TN "MycoAgent"
if ($LASTEXITCODE -ne 0) { throw "schtasks run failed: $LASTEXITCODE" }

Write-Host 'MycoAgent task registered and started; poll ping on 127.0.0.1:8765.'
