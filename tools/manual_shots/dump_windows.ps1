param([Parameter(Mandatory=$true)][int]$pidTarget)
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class E {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static void Dump(uint target) {
    EnumWindows((h,l)=>{
      uint pid; GetWindowThreadProcessId(h,out pid);
      if(pid==target){
        var t=new StringBuilder(128); GetWindowTextW(h,t,128);
        var c=new StringBuilder(128); GetClassNameW(h,c,128);
        RECT r; GetWindowRect(h,out r);
        string vis = IsWindowVisible(h) ? "V" : "H";
        Console.WriteLine(vis+" ["+r.L+","+r.T+" "+(r.R-r.L)+"x"+(r.B-r.T)+"] class="+c+" title="+t);
      }
      return true;
    }, IntPtr.Zero);
  }
}
"@
Add-Type -TypeDefinition $src
[E]::Dump([uint32]$pidTarget)
