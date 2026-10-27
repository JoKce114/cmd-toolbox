$ErrorActionPreference = 'Continue'
$root = 'D:\project-demo\cmd-toolbox'
$log = Join-Path $root '.test-data\console-reader.log'
Remove-Item $log -ErrorAction SilentlyContinue
Add-Type -Path (Join-Path $root 'tests\ConsoleInputInject.cs')

$out = New-Object System.Collections.Generic.List[string]
$out.Add([ConsoleInputInject]::FreshConsole())
$out.Add("current conin=" + [ConsoleInputInject]::OpenCurrentConin())

$reader = Join-Path $root 'tests\console-key-reader-file.ps1'
$child = Start-Process powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File', $reader, '-Log', $log) -NoNewWindow -PassThru
$out.Add("child pid=" + $child.Id)
Start-Sleep -Milliseconds 1500

$h = [ConsoleInputInject]::OpenCurrentConin()
$out.Add("handle=$h err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
if ($h -ne [IntPtr]::Zero -and $h -ne [IntPtr]::new(-1)) {
  $out.Add([ConsoleInputInject]::InjectKey($h, 0x5A, 0x2C, [char]'z', 0))
  [ConsoleInputInject]::Close($h)
  $h2 = [ConsoleInputInject]::OpenCurrentConin()
  $out.Add([ConsoleInputInject]::InjectKey($h2, 0x4A, 0x24, [char]10, 0x0008))
  [ConsoleInputInject]::Close($h2)
}
Start-Sleep -Milliseconds 1500

try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch {}
[ConsoleInputInject]::Detach()
$out.Add('reader log:')
try { $out.AddRange([string[]](Get-Content $log -ErrorAction Stop)) } catch { $out.Add('no log') }
$out | Set-Content -Path (Join-Path $root '.test-data\console-inject-self.log') -Encoding UTF8
