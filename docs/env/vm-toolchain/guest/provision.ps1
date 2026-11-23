# Installs the Myco toolchain from the seed drive payload (offline, checksummed on the host). Idempotent.
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force C:\myco\bin, C:\myco\logs | Out-Null
Start-Transcript C:\myco\logs\provision.log -Append
Set-ExecutionPolicy -Scope LocalMachine RemoteSigned -Force
$seed = (Get-PSDrive -PSProvider FileSystem | Where-Object { Test-Path "$($_.Root)myco-seed.marker" } | Select-Object -First 1).Root
$pay = Join-Path $seed 'payload'; Write-Host "payload: $pay"
function Run($exe, $a) { Write-Host ">> $exe $a"; $p = Start-Process $exe -ArgumentList $a -Wait -PassThru; Write-Host "   exit $($p.ExitCode)" }
if (-not (Get-ChildItem 'C:\Program Files\Python312*\python.exe' -ErrorAction SilentlyContinue)) { Run (Get-Item "$pay\python-3.12*-arm64.exe").FullName '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0 Include_launcher=1 Shortcuts=0' }
if (-not (Test-Path 'C:\Program Files\Git\cmd\git.exe')) { Run (Get-Item "$pay\Git-*-arm64.exe").FullName '/VERYSILENT /NORESTART /SP- /SUPPRESSMSGBOXES /NOCANCEL /COMPONENTS="gitlfs,assoc,assoc_sh"' }
if (-not (Test-Path 'C:\Program Files\LibreOffice\program\soffice.exe')) {
  $m = (Get-Item "$pay\LibreOffice_*_Win_aarch64.msi").FullName
  Run msiexec.exe "/i `"$m`" /qn /norestart ALLUSERS=1 CREATEDESKTOPLINK=0 REGISTER_ALL_MSO_TYPES=0 REGISTER_NO_MSO_TYPES=1 ISCHECKFORPRODUCTUPDATES=0 QUICKSTART=0 UI_LANGS=en_US /l*v C:\myco\logs\libreoffice-msi.log"
}
# Suppress LibreOffice first-run UI (tip of the day, what's new, update checks) for every profile, so automation never hits a surprise dialog.
$xcd = @'
<?xml version="1.0" encoding="UTF-8"?>
<oor:data xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:oor="http://openoffice.org/2001/registry">
<dependency file="main"/>
<oor:component-data oor:package="org.openoffice.Office" oor:name="Common"><node oor:name="Misc">
<prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop>
<prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop>
</node></oor:component-data>
<oor:component-data oor:package="org.openoffice" oor:name="Setup"><node oor:name="Product">
<prop oor:name="ooSetupLastVersion" oor:op="fuse"><value>99.0</value></prop>
</node></oor:component-data>
<oor:component-data oor:package="org.openoffice.Office" oor:name="Jobs"><node oor:name="Jobs"><node oor:name="UpdateCheck"><node oor:name="Arguments">
<prop oor:name="AutoCheckEnabled" oor:op="fuse"><value>false</value></prop>
</node></node></node></oor:component-data>
</oor:data>
'@
if (Test-Path 'C:\Program Files\LibreOffice\share\registry') { Set-Content 'C:\Program Files\LibreOffice\share\registry\myco.xcd' $xcd -Encoding UTF8 }
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine')
$py = (Get-ChildItem 'C:\Program Files\Python312*\python.exe' | Select-Object -First 1).FullName; Write-Host "python: $py"
& $py -m pip install --upgrade pip 2>&1 | Select-Object -Last 1
foreach ($pkg in 'pywin32','comtypes','pywinauto','uiautomation') { Write-Host ">> pip install $pkg"; & $py -m pip install $pkg 2>&1 | Select-Object -Last 2 }
& $py -c "import platform,sys; print('python', sys.version, platform.machine())"
& $py -c "import win32api, comtypes, pywinauto; print('pywinauto', pywinauto.__version__, 'OK')"
& $py -c "import uiautomation as a; print('uiautomation', a.VERSION, 'OK')"
Stop-Transcript
