param(
  [Parameter(Mandatory=$true)][int]$x,
  [Parameter(Mandatory=$true)][int]$y,
  [Parameter(Mandatory=$true)][int]$pidTarget
)
# Click at (x,y) inside the onceglance main window, coordinates are
# image-space physical pixels (origin = window visible top-left).
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr FindByPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) {
        RECT r; DwmGetWindowAttribute(h, 9, out r, 16);
        int w = r.R - r.L, ht = r.B - r.T;
        var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
        if (w > 200 && ht > 200 && r.L > -500 && sb.ToString().Contains("Onceglance")) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
Add-Type -TypeDefinition $src
[W]::SetProcessDPIAware() | Out-Null
$h = [W]::FindByPid([uint32]$pidTarget)
if ($h -eq [IntPtr]::Zero) { Write-Output "ERR window not found for pid $pidTarget"; exit 1 }
$r = New-Object W+RECT
[W]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null
$sx = $r.L + $x; $sy = $r.T + $y
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 250
[W]::SetCursorPos($sx, $sy) | Out-Null
Start-Sleep -Milliseconds 120
[W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Write-Output "OK clicked screen($sx,$sy) winOrigin($($r.L),$($r.T))"
