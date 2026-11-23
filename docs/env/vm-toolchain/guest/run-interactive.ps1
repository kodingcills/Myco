# Run a command inside myco's interactive desktop session (session 1) from a non-interactive SSH session.
# SSH sessions live in session 0 and cannot see or drive the desktop; a scheduled task with an
# Interactive-logon principal runs in the logged-on user's desktop instead (no password needed).
# usage: run-interactive.ps1 -Exe <path> [-ArgList <string>] [-Wait] [-TimeoutSec 300] [-Name myco-ui]
param([Parameter(Mandatory)][string]$Exe, [string]$ArgList = '', [switch]$Wait, [int]$TimeoutSec = 300, [string]$Name = "myco-ui-$([guid]::NewGuid().ToString('N').Substring(0,8))", [string]$WorkDir = 'C:\myco')
$ErrorActionPreference = 'Stop'
$a = if ($ArgList) { New-ScheduledTaskAction -Execute $Exe -Argument $ArgList -WorkingDirectory $WorkDir } else { New-ScheduledTaskAction -Execute $Exe -WorkingDirectory $WorkDir }
$p = New-ScheduledTaskPrincipal -UserId 'myco' -LogonType Interactive -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 12) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Name -Action $a -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName $Name
if ($Wait) {
  $t0 = Get-Date; Start-Sleep -Milliseconds 500
  while ((Get-ScheduledTask -TaskName $Name).State -eq 'Running') { if (((Get-Date) - $t0).TotalSeconds -gt $TimeoutSec) { Stop-ScheduledTask -TaskName $Name; throw "timeout" }; Start-Sleep -Milliseconds 500 }
  $r = (Get-ScheduledTaskInfo -TaskName $Name).LastTaskResult
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  Write-Output "exit=$r"; exit $r
} else { Write-Output "started task $Name" }
