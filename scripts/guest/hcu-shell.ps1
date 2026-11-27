# TIF-268: the guest side of the hcu+shell arm's read-only shell (src/baseline/hcu-shell/shell-tool.ts).
#
# The harness copies this file into the guest at prepare time and runs it over SSH, once per shell
# call the arm makes, with the path the host already checked against the shell policy:
#
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File hcu-shell.ps1 `
#     -Op ls|cat|sha256|convert-csv -PathB64 <base64 utf-8 path> -ScratchB64 <base64 utf-8 path>
#
# It prints exactly one JSON line: {"output": "...", "accesses": [{"operation": "read"|"write",
# "path": "<resolved path>"}]}. Every path it reports is resolved through the open handle
# (GetFinalPathNameByHandleW), so a symlink or junction that points at grader material shows up
# as the real target, and the host's checkResolvedAccesses refuses it. On any error it prints no
# JSON and exits non-zero: the host then records the call as unaudited and the row is uncertain.
#
# Paths come base64-encoded so that no shell on the way parses them. Nothing here writes outside
# the scratch directory: convert-csv puts its CSV and its soffice profile under it.
param(
  [Parameter(Mandatory = $true)][ValidateSet('ls', 'cat', 'sha256', 'convert-csv')][string]$Op,
  [Parameter(Mandatory = $true)][string]$PathB64,
  [Parameter(Mandatory = $true)][string]$ScratchB64
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class MycoRealPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sec,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder buf, uint size, uint flags);
  public static string Resolve(string path) {
    // 0x02000000 FILE_FLAG_BACKUP_SEMANTICS opens directories too; access 0 queries only.
    using (SafeFileHandle h = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (h.IsInvalid) throw new Exception("open-failed");
      StringBuilder buf = new StringBuilder(1024);
      uint n = GetFinalPathNameByHandleW(h, buf, 1024, 0);
      if (n == 0 || n >= 1024) throw new Exception("resolve-failed");
      string s = buf.ToString();
      if (s.StartsWith(@"\\?\UNC\")) throw new Exception("unc-path");
      if (s.StartsWith(@"\\?\")) s = s.Substring(4);
      return s;
    }
  }
}
"@

function From-B64([string]$s) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
function Access([string]$operation, [string]$path) {
  [ordered]@{ operation = $operation; path = [MycoRealPath]::Resolve($path) }
}

$path = From-B64 $PathB64
$scratch = From-B64 $ScratchB64
$accesses = New-Object System.Collections.ArrayList
$output = ''

switch ($Op) {
  'ls' {
    $real = [MycoRealPath]::Resolve($path)
    [void]$accesses.Add((Access 'read' $real))
    $lines = Get-ChildItem -LiteralPath $real -Force | ForEach-Object {
      $len = if ($_.PSIsContainer) { '<dir>' } else { [string]$_.Length }
      "{0}`t{1}`t{2}" -f $_.Name, $len, $_.LastWriteTimeUtc.ToString('o')
    }
    $output = ($lines -join "`n")
  }
  'cat' {
    $real = [MycoRealPath]::Resolve($path)
    [void]$accesses.Add((Access 'read' $real))
    $fs = [IO.File]::OpenRead($real)
    try {
      $buf = New-Object byte[] 65536
      $n = $fs.Read($buf, 0, $buf.Length)
      $output = [Text.Encoding]::UTF8.GetString($buf, 0, $n)
    } finally { $fs.Dispose() }
  }
  'sha256' {
    $real = [MycoRealPath]::Resolve($path)
    [void]$accesses.Add((Access 'read' $real))
    $output = (Get-FileHash -LiteralPath $real -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  'convert-csv' {
    $real = [MycoRealPath]::Resolve($path)
    $scratchReal = [MycoRealPath]::Resolve($scratch)
    [void]$accesses.Add((Access 'read' $real))
    $work = Join-Path $scratchReal ('conv-' + [guid]::NewGuid().ToString('N'))
    $outDir = Join-Path $work 'out'
    $profileDir = Join-Path $work 'profile'
    New-Item -ItemType Directory -Path $outDir, $profileDir -Force | Out-Null
    [void]$accesses.Add((Access 'write' $outDir))
    [void]$accesses.Add((Access 'write' $profileDir))
    $profUrl = 'file:///' + ($profileDir -replace '\\', '/')
    $soffice = 'C:\Program Files\LibreOffice\program\soffice.exe'
    $argList = @("-env:UserInstallation=$profUrl", '--headless', '--norestore',
      '--convert-to', 'csv', '--outdir', "`"$outDir`"", "`"$real`"")
    $p = Start-Process -FilePath $soffice -ArgumentList $argList -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(120000)) { $p.Kill(); throw 'convert-timeout' }
    $csv = Join-Path $outDir ([IO.Path]::GetFileNameWithoutExtension($real) + '.csv')
    [void]$accesses.Add((Access 'read' $csv))
    $output = [IO.File]::ReadAllText([MycoRealPath]::Resolve($csv), [Text.Encoding]::UTF8)
  }
}

$result = [ordered]@{ output = [string]$output; accesses = @($accesses) }
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
