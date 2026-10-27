param(
  [int]$TargetPid,
  [string]$Mode = 'key',
  [int]$Delta = 120,
  [string]$Log = 'D:\project-demo\cmd-toolbox\.test-data\inject.log'
)

$ErrorActionPreference = 'Continue'
Add-Type -Path 'D:\project-demo\cmd-toolbox\tests\ConsoleInputInject.cs'

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("start target=$TargetPid mode=$Mode")
$lines.Add([ConsoleInputInject]::Attach([uint32]$TargetPid))
$h = [ConsoleInputInject]::OpenCurrentConin()
$lines.Add("handle=$h err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())")
if ($h -ne [IntPtr]::Zero -and $h -ne [IntPtr]::new(-1)) {
  if ($Mode -eq 'key') {
    $lines.Add([ConsoleInputInject]::InjectKey($h, 0x4A, 0x24, [char]10, 0x0008))
  } elseif ($Mode -eq 'ctrlj') {
    $lines.Add([ConsoleInputInject]::InjectKey($h, 0x4A, 0x24, [char]10, 0x0008))
  } elseif ($Mode -eq 'z') {
    $lines.Add([ConsoleInputInject]::InjectKey($h, 0x5A, 0x2C, [char]'z', 0))
  } else {
    $lines.Add([ConsoleInputInject]::InjectWheel($h, 10, 10, $Delta))
  }
  [ConsoleInputInject]::Close($h)
}
[ConsoleInputInject]::Detach()
$lines.Add('done')
$lines | Set-Content -Path $Log -Encoding UTF8
