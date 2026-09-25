param([Parameter(Mandatory=$true)][int]$pidTarget)
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class A {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static IntPtr Find(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h,l)=>{
      uint pid; GetWindowThreadProcessId(h,out pid);
      if (pid==target && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h,out r);
        var sb=new StringBuilder(256); GetWindowTextW(h,sb,256);
        if (r.R-r.L>300 && r.B-r.T>300 && sb.Length>0) { found=h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
Add-Type -TypeDefinition $src
[A]::SetProcessDPIAware()
$h = [A]::Find([uint32]$pidTarget)
if ($h -eq [IntPtr]::Zero) { Write-Output "ERR not found"; exit 1 }
[A]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
[A]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [A]::SetForegroundWindow($h) | Out-Null; [A]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
$r = New-Object A+RECT
[A]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output "activated rect($($r.L),$($r.T),$($r.R-$r.L)x$($r.B-$r.T))"
