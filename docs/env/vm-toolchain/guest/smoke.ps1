# Myco VM smoke test orchestrator (run over SSH). Prints a JSON summary.
$ErrorActionPreference = 'Stop'
$so = 'C:\Program Files\LibreOffice\program\soffice.com'; $py = (Get-ChildItem 'C:\Program Files\Python312*\python.exe' | Select-Object -First 1).FullName
$d = 'C:\myco\smoke'; Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $d | Out-Null
# Upper-case on purpose: LibreOffice AutoCorrect capitalizes a lower-case first letter ("myco-..." persists as "Myco-..."),
# which a case-insensitive check would wrongly pass. Compare case-sensitively (-ceq).
$val = "MYCO-SMOKE-$(Get-Random -Maximum 99999)"
# 1) seed an .ods headlessly (separate profile so it never collides with the GUI instance)
Set-Content "$d\seed.csv" "placeholder,B`r`n1,2" -Encoding ascii
& $so --headless "-env:UserInstallation=file:///C:/myco/lo-headless-profile" --convert-to ods --outdir $d "$d\seed.csv" | Out-Null
Rename-Item "$d\seed.ods" 'smoke.ods'
# 2) GUI edit through UI Automation in the interactive session
& C:\myco\bin\run-interactive.ps1 -Exe $py -ArgList "C:\myco\bin\smoke_calc_uia.py $val" -Wait -TimeoutSec 240 | Out-Null
$uia = Get-Content "$d\uia_report.json" -Raw | ConvertFrom-Json
# 3) independent headless read-back of the persisted file
New-Item -ItemType Directory -Force "$d\readback" | Out-Null
& $so --headless "-env:UserInstallation=file:///C:/myco/lo-headless-profile" --convert-to csv --outdir "$d\readback" "$d\smoke.ods" | Out-Null
$a1 = ((Get-Content "$d\readback\smoke.csv" -TotalCount 1) -split ',')[0].Trim('"')
[pscustomobject]@{ expected = $val; persisted_A1 = $a1; pass = ($a1 -ceq $val); uia_ok = $uia.ok; uia_error = $uia.error;
  window = ($uia.steps | Where-Object step -eq 'window_found'); uia_elements = ($uia.steps | Where-Object step -eq "uia_enumerated").element_count; uia_cell = ($uia.steps | Where-Object step -eq "uia_cell_A1"); foreground = ($uia.steps | Where-Object step -eq "foreground").ok } | ConvertTo-Json -Depth 4
