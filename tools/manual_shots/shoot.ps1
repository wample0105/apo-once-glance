param(
  [Parameter(Mandatory=$true)][string]$cmd,
  [int]$x, [int]$y, [int]$x2, [int]$y2, [string]$key, [int]$pidGuard
)
# Shoot driver for the onceglance freeze overlay.
# Coordinates are PHYSICAL screen pixels. Guard: foreground window must belong
# to the onceglance process (pid via -pidGuard); 'hotkey' and 'fg' skip guard.
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  public static string ForegroundTitle() {
    var sb = new StringBuilder(256); GetWindowTextW(GetForegroundWindow(), sb, 256); return sb.ToString();
  }
  public static uint ForegroundPid() {
    uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid;
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); System.Threading.Thread.Sleep(120);
    mouse_event(2,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(150);
    int steps = 14;
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(x1 + (x2-x1)*i/steps, y1 + (y2-y1)*i/steps);
      System.Threading.Thread.Sleep(35);
    }
    System.Threading.Thread.Sleep(120);
    mouse_event(4,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(100);
  }
  public static void Tap(byte vk) {
    keybd_event(vk, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60);
    keybd_event(vk, 0, 2, UIntPtr.Zero); System.Threading.Thread.Sleep(60);
  }
}
"@
Add-Type -TypeDefinition $src
[W]::SetProcessDPIAware() | Out-Null

# foreground guard by process id (encoding-proof)
if ($cmd -ne "hotkey" -and $cmd -ne "fg") {
  if ($pidGuard -le 0 -or [W]::ForegroundPid() -ne [uint32]$pidGuard) {
    Write-Output "GUARD-FAIL fgpid=$([W]::ForegroundPid()) want=$pidGuard"
    exit 2
  }
}
switch ($cmd) {
  "fg"     { Write-Output "FG='$fg'" }
  "move"   { [W]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 250; Write-Output "OK move ($x,$y)" }
  "click"  { [W]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 150;
             [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60;
             [W]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 150; Write-Output "OK click ($x,$y)" }
  "dblclick" { [W]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 150;
             foreach ($n in 1,2) { [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40;
                                   [W]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 90 }
             Start-Sleep -Milliseconds 200; Write-Output "OK dblclick ($x,$y)" }
  "drag"   { [W]::Drag($x, $y, $x2, $y2); Write-Output "OK drag ($x,$y)->($x2,$y2)" }
  "hotkey" { # Alt+Shift+A : 0x12 0x10 'A'(0x44)
             [W]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [W]::keybd_event(0x10,0,0,[UIntPtr]::Zero);
             [W]::Tap(0x44);
             [W]::keybd_event(0x10,0,2,[UIntPtr]::Zero); [W]::keybd_event(0x12,0,2,[UIntPtr]::Zero);
             Start-Sleep -Milliseconds 400; Write-Output "OK hotkey Alt+Shift+A" }
  "wheel"  { # negative delta = scroll down; -notch = notches
             [W]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 200
             $notches = if ($y2 -lt 0) { $y2 } else { -3 }
             for ($i = 0; $i -lt [Math]::Abs($notches); $i++) {
               $d = [int]120 * [Math]::Sign($notches)
               $u = if ($d -lt 0) { [uint32]($d + 4294967296) } else { [uint32]$d }
               [W]::mouse_event(0x0800, 0, 0, $u, [UIntPtr]::Zero)
               Start-Sleep -Milliseconds 90
             }
             Write-Output "OK wheel $($notches) notches at ($x,$y)" }
  "key"    { $vk = switch ($key.ToLower()) {
               "a" {0x41} "n" {0x4E} "r" {0x52} "d" {0x44} "l" {0x4C} "v" {0x56}
               "esc" {0x1B} "enter" {0x0D} "tab" {0x09} "t" {0x54} "m" {0x4D} default {0}
             }
             if ($vk -eq 0) { Write-Output "ERR unknown key $key"; exit 1 }
             [W]::Tap([byte]$vk); Write-Output "OK key $key" }
  default  { Write-Output "ERR unknown cmd $cmd"; exit 1 }
}
