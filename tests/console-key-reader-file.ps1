param([string]$Log = 'D:\project-demo\cmd-toolbox\.test-data\console-reader.log')
$h = $Host.UI.RawUI
Add-Content -Path $Log -Value ("reader start pid=" + $PID)
$n = 0
while ($true) {
  try {
    $k = $h.ReadKey('NoEcho,IncludeKeyDown')
    $n = $n + 1
    $vk = [int]$k.VirtualKeyCode
    $ch = [int]$k.Character
    $st = $k.ControlKeyState
    Add-Content -Path $Log -Value ("KEY #$n vk=$vk ch=$ch st=$st")
  } catch {
    $n = $n + 1
    Add-Content -Path $Log -Value ("ERR #$n " + $_.Exception.Message)
  }
}
