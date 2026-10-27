param(
  [Parameter(Mandatory = $true)][int]$RootProcessId,
  [Parameter(Mandatory = $true)][ValidateSet('bottom', 'restore')][string]$Action,
  [int]$WaitSeconds = 0
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CmdToolboxZOrder
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    public static IntPtr[] FindWindows(int[] pids)
    {
        var wanted = new HashSet<uint>();
        foreach (int pid in pids) wanted.Add((uint)pid);

        var found = new List<IntPtr>();
        EnumWindows((hWnd, lParam) =>
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (wanted.Contains(pid) && IsWindowVisible(hWnd)) found.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }

    public static int Move(IntPtr[] windows, bool bottom)
    {
        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOMOVE = 0x0002;
        const uint SWP_NOACTIVATE = 0x0010;
        IntPtr insertAfter = new IntPtr(bottom ? 1 : 0);

        int changed = 0;
        foreach (IntPtr hWnd in windows)
        {
            if (SetWindowPos(hWnd, insertAfter, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)) changed += 1;
        }
        return changed;
    }
}
"@

function Get-ProcessTreeIds {
  $processes = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $set = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$set.Add($RootProcessId)

  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($process in $processes) {
      if ($set.Contains([int]$process.ParentProcessId) -and -not $set.Contains([int]$process.ProcessId)) {
        [void]$set.Add([int]$process.ProcessId)
        $grew = $true
      }
    }
  }
  return $set
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$ids = Get-ProcessTreeIds
$windows = [CmdToolboxZOrder]::FindWindows(@($ids))
while ($windows.Count -eq 0 -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 350
  $ids = Get-ProcessTreeIds
  $windows = [CmdToolboxZOrder]::FindWindows(@($ids))
}

$changed = [CmdToolboxZOrder]::Move($windows, $Action -eq 'bottom')
Write-Output "zorder=$Action windows=$($windows.Count) changed=$changed pids=$($ids.Count)"
