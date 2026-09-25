param([Parameter(Mandatory=$true)][string]$kw)
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class C {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static int CloseByTitle(string kw) {
    int n = 0;
    EnumWindows((h,l)=>{ var sb=new StringBuilder(256); GetWindowTextW(h,sb,256);
      if (sb.ToString().Contains(kw)) { PostMessageW(h, 0x0010, IntPtr.Zero, IntPtr.Zero); n++; }
      return true; }, IntPtr.Zero);
    return n;
  }
}
"@
Add-Type -TypeDefinition $src
$cnt = [C]::CloseByTitle($kw)
Write-Output "closed windows containing '$kw': $cnt"
