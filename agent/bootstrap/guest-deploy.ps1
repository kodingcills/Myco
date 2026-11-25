# Guest-side half of deploy-to-vm.sh. Run over SSH (session 0 is fine):
#   powershell -ExecutionPolicy Bypass -File guest-deploy.ps1 -Stage prepare
#   powershell -ExecutionPolicy Bypass -File guest-deploy.ps1 -Stage register
#   powershell -ExecutionPolicy Bypass -File guest-deploy.ps1 -Stage manifest
# Keeps PowerShell quoting out of the bash script.
param([Parameter(Mandatory = $true)][ValidateSet('prepare', 'register', 'manifest')] [string]$Stage)

$ErrorActionPreference = 'Stop'
$agentDir = 'C:\Program Files\Myco\agent'
$tokenPath = 'C:\ProgramData\Myco\agent.token'

if ($Stage -eq 'prepare') {
    New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
    # Start each copy from an empty wheel directory, so only this deploy's
    # pinned wheels are offered to pip (TIF-275).
    $wheelDir = Join-Path $agentDir 'wheels'
    if (Test-Path -LiteralPath $wheelDir) { Remove-Item -LiteralPath $wheelDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path $tokenPath) | Out-Null
    Write-Output "prepared $agentDir and $(Split-Path $tokenPath)"
    exit 0
}

if ($Stage -eq 'manifest') {
    # TIF-220: what landed on the guest, so deploy-to-vm.sh can refuse a partial
    # copy left by a dropped scp. One line per file under the three copied roots,
    # "<sha256 lowercase>  <relative/path>" - the exact format of `shasum -a 256`
    # on the host, which deploy-to-vm.sh compares against line for line.
    $root = (Resolve-Path -LiteralPath $agentDir).Path.TrimEnd('\')
    # A root that is missing (a dropped copy) simply contributes no lines; the
    # host then reports those files as missing. Files and directories are
    # enumerated separately rather than relying on Get-ChildItem's handling of
    # a file path under -Recurse.
    $files = foreach ($name in @('myco_agent', 'bootstrap', 'pyproject.toml')) {
        $p = Join-Path $root $name
        if (Test-Path -LiteralPath $p -PathType Leaf) { Get-Item -LiteralPath $p -Force }
        elseif (Test-Path -LiteralPath $p -PathType Container) { Get-ChildItem -LiteralPath $p -Recurse -File -Force }
    }
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Output "$hash  $rel"
    }
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
# OFFLINE (TIF-275): the guest has no internet. The wheels came in with the
# tree copy (deploy-to-vm.sh fetched them on the host); --no-index forbids any
# network lookup and --require-hashes makes pip check each wheel against the
# sha256 pinned in guest-requirements.txt, refusing anything else.
$wheelDir = Join-Path $agentDir 'wheels'
$reqs = Join-Path $agentDir 'bootstrap\guest-requirements.txt'
& $pyExe -m pip install --quiet --no-warn-script-location --disable-pip-version-check `
    --no-index --find-links $wheelDir --require-hashes -r $reqs
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
