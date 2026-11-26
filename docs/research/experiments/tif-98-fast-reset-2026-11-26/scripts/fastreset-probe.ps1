$ErrorActionPreference = 'SilentlyContinue'
$ev = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Boot'; Id=27} -MaxEvents 1
$bt = $null; if ($ev) { $bt = ([regex]::Match($ev.Message, '0x[0-9a-fA-F]+')).Value }
$m = 'C:\Users\myco\fastreset-marker.txt'
$hb = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power').HiberbootEnabled
$o = [ordered]@{
  tickUptimeS = [int]([Environment]::TickCount64 / 1000)
  bootEventTimeUtc = $(if ($ev) { $ev.TimeCreated.ToUniversalTime().ToString('o') } else { $null })
  bootType = $bt
  markerPresent = (Test-Path -LiteralPath $m)
  marker = $(if (Test-Path -LiteralPath $m) { (Get-Content -LiteralPath $m -Raw).Trim() } else { $null })
  hiberbootEnabled = $hb
  hiberfilPresent = [bool](Get-ChildItem -LiteralPath 'C:\' -Force -Filter 'hiberfil.sys')
}
$o | ConvertTo-Json -Compress
