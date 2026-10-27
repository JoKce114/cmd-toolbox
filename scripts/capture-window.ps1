param(
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CmdToolboxWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
}
"@

$process = Get-Process |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*Cmd Toolbox*' } |
  Select-Object -First 1

if (-not $process) {
  throw '未找到 Cmd Toolbox 窗口'
}

$handle = $process.MainWindowHandle
[void][CmdToolboxWindow]::ShowWindow($handle, 9)
[void][CmdToolboxWindow]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, 0x0043)
Start-Sleep -Milliseconds 600

$rect = New-Object CmdToolboxWindow+RECT
[void][CmdToolboxWindow]::GetWindowRect($handle, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::White)
$mode = 'screen'
try {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
} catch {
  $mode = 'printwindow'
  $hdc = $graphics.GetHdc()
  try {
    [void][CmdToolboxWindow]::PrintWindow($handle, $hdc, 2)
  } finally {
    $graphics.ReleaseHdc($hdc)
  }
}
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
[void][CmdToolboxWindow]::SetWindowPos($handle, [IntPtr](-2), 0, 0, 0, 0, 0x0043)

Write-Output "captured ${width}x${height} via $mode -> $Out"
