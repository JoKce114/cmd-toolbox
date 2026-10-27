$h = $Host.UI.RawUI
$n = 0
while ($true) {
  try {
    $k = $h.ReadKey('NoEcho,IncludeKeyDown')
    $n = $n + 1
    $vk = [int]$k.VirtualKeyCode
    $ch = [int]$k.Character
    $st = $k.ControlKeyState
    Write-Host ("KEY #$n vk=$vk ch=$ch st=$st")
  } catch {
    $n = $n + 1
    Write-Host ("ERR #$n " + $_.Exception.Message)
  }
}
