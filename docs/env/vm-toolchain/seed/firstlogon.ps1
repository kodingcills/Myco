# Myco first-logon provisioning (runs once as the auto-logged-on 'myco' admin via FirstLogonCommands).
# Idempotent: safe to re-run.
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force C:\myco | Out-Null
Start-Transcript -Path C:\myco\firstlogon.log -Append
$seed = (Get-PSDrive -PSProvider FileSystem | Where-Object { Test-Path "$($_.Root)myco-seed.marker" } | Select-Object -First 1).Root
Write-Host "seed drive: $seed"

function Step($name, [scriptblock]$b) { Write-Host "=== $name"; try { & $b } catch { Write-Host "FAILED $name : $_" } }

Step 'power: no sleep, no hibernate, no monitor off, no lock on wake' {
  powercfg /hibernate off
  foreach ($s in 'monitor-timeout-ac','monitor-timeout-dc','standby-timeout-ac','standby-timeout-dc','disk-timeout-ac','hibernate-timeout-ac') { powercfg /change $s 0 }
  powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
  powercfg /setdcvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
  powercfg /setactive SCHEME_CURRENT
}
Step 'lock screen / screensaver off' {
  New-Item -Force 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' NoLockScreen 1 -Type DWord
  Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' InactivityTimeoutSecs 0 -Type DWord
  New-Item -Force 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop' | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop' ScreenSaveActive '0'
  Set-ItemProperty 'HKCU:\Control Panel\Desktop' ScreenSaveActive '0'
  Set-ItemProperty 'HKCU:\Control Panel\Desktop' ScreenSaverIsSecure '0'
}
Step 'UAC: keep enabled, no prompts for admins (so automation never blocks on a secure-desktop dialog)' {
  $p='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  Set-ItemProperty $p ConsentPromptBehaviorAdmin 0 -Type DWord
  Set-ItemProperty $p PromptOnSecureDesktop 0 -Type DWord
}
Step 'permanent auto-logon' {
  $w='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $w AutoAdminLogon '1'
  Set-ItemProperty $w DefaultUserName 'myco'
  Remove-ItemProperty $w AutoLogonCount -ErrorAction SilentlyContinue
}
Step 'freeze Windows Update (deterministic trials), no OOBE nags' {
  New-Item -Force 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' NoAutoUpdate 1 -Type DWord
  New-Item -Force 'HKCU:\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement' | Out-Null
  Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement' ScoobeSystemSettingEnabled 0 -Type DWord
  New-Item -Force 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' DisableWindowsConsumerFeatures 1 -Type DWord
}
Step 'trust virtio/UTM driver publishers, install ARM64 drivers' {
  if ($seed) {
    Get-ChildItem "$seed\Drivers" -Recurse -Filter *.cat -ErrorAction SilentlyContinue | ForEach-Object {
      $c = (Get-AuthenticodeSignature $_.FullName).SignerCertificate
      if ($c) { $f="$env:TEMP\$($c.Thumbprint).cer"; [IO.File]::WriteAllBytes($f, $c.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)); certutil -f -addstore TrustedPublisher $f | Out-Null }
    }
    Get-ChildItem "$seed\Drivers" -Recurse -Filter *.inf | Where-Object { $_.FullName -match '\\w11\\ARM64\\' } | ForEach-Object { pnputil /add-driver $_.FullName /install }
  }
}
Step 'OpenSSH Server (Win32-OpenSSH ARM64 MSI from seed, fallback to Windows capability)' {
  $msi = Get-ChildItem "$seed\payload\OpenSSH-ARM64-*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($msi) { Start-Process msiexec.exe -Wait -ArgumentList "/i `"$($msi.FullName)`" /qn /norestart /l*v C:\myco\openssh-msi.log" }
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 }
  $pd='C:\ProgramData\ssh'; New-Item -ItemType Directory -Force $pd | Out-Null
  Start-Service sshd -ErrorAction SilentlyContinue; Stop-Service sshd -ErrorAction SilentlyContinue  # generates host keys + default config
  Copy-Item "$seed\myco_authorized_keys" "$pd\administrators_authorized_keys" -Force
  icacls "$pd\administrators_authorized_keys" /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'
  $cfg="$pd\sshd_config"
  if (Test-Path $cfg) {
    $t = Get-Content $cfg -Raw
    $t = $t -replace '(?m)^#?\s*PasswordAuthentication\s+\w+', 'PasswordAuthentication no'
    $t = $t -replace '(?m)^#?\s*PubkeyAuthentication\s+\w+', 'PubkeyAuthentication yes'
    if ($t -notmatch '(?m)^PasswordAuthentication') { $t = "PasswordAuthentication no`r`n" + $t }
    Set-Content $cfg $t -Encoding ascii
  }
  New-Item -Force 'HKLM:\SOFTWARE\OpenSSH' | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\OpenSSH' DefaultShell "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  Set-Service sshd -StartupType Automatic; Start-Service sshd
  if (-not (Get-NetFirewallRule -Name myco-sshd -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name myco-sshd -DisplayName 'OpenSSH Server (myco)' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -Profile Any | Out-Null }
}
Step 'network profile private' { Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue }
Step 'UTM guest tools (SPICE agent, qemu-ga, drivers) silent install' {
  $gt = Get-ChildItem "$seed\utm-guest-tools-*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($gt) { Start-Process $gt.FullName -ArgumentList '/S' -Wait }
}
Set-Content C:\myco\firstlogon.done (Get-Date -Format o)
Stop-Transcript
