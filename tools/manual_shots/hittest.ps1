param([int]$x, [int]$y)
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class H {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static void Hit(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    for (int i = 0; i < 5 && h != IntPtr.Zero; i++) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var t = new StringBuilder(128); GetWindowTextW(h, t, 128);
      var c = new StringBuilder(128); GetClassNameW(h, c, 128);
      Console.WriteLine("level" + i + ": pid=" + pid + " class=" + c + " title=" + t);
      h = GetAncestor(h, 2); // GA_ROOT
      if (i == 0) continue;
      break;
    }
  }
}
"@
Add-Type -TypeDefinition $src
[H]::SetProcessDPIAware()
[H]::Hit($x, $y)
