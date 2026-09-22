# 枚举所有可见顶层窗口：rect + 标题 + 类名 + 进程，找出全屏挡板的真身
import ctypes
from ctypes import wintypes
import PIL.ImageGrab

user32 = ctypes.windll.user32
GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x20
WS_EX_LAYERED = 0x80000
WS_EX_TOPMOST = 0x8
EnumWindows = user32.EnumWindows
IsWindowVisible = user32.IsWindowVisible
GetWindowRect = user32.GetWindowRect
GetWindowTextW = user32.GetWindowTextW
GetClassNameW = user32.GetClassNameW
GetWindowLongW = user32.GetWindowLongW
GetWindowThreadProcessId = user32.GetWindowThreadProcessId
GetAncestor = user32.GetAncestor
GA_ROOT = 2

W, H = PIL.ImageGrab.grab().size
rows = []
@ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND)
def cb(hwnd):
    if not IsWindowVisible(hwnd): return True
    if GetAncestor(hwnd, GA_ROOT) != hwnd: return True
    r = wintypes.RECT()
    if not GetWindowRect(hwnd, ctypes.byref(r)): return True
    w, h = r.right-r.left, r.bottom-r.top
    if w < 50 or h < 50: return True
    buf = ctypes.create_unicode_buffer(256)
    GetWindowTextW(hwnd, buf, 256); title = buf.value
    GetClassNameW(hwnd, buf, 256); cls = buf.value
    pid = wintypes.DWORD()
    GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    ex = GetWindowLongW(hwnd, GWL_EXSTYLE) & 0xFFFFFFFF
    flags = ("TOP " if ex & WS_EX_TOPMOST else "") + ("LAY " if ex & WS_EX_LAYERED else "") + ("TRN " if ex & WS_EX_TRANSPARENT else "")
    cov = (w >= W*0.9 and h >= H*0.9)
    rows.append((cov, f"{'FULL' if cov else 'win '} | {r.left:6d},{r.top:6d} {w:5d}x{h:<5d} | {flags:12s} | pid={pid.value:6d} | {cls[:24]:24s} | {title[:40]}"))
    return True
EnumWindows(cb, 0)
import subprocess
pids = set()
for row in rows:
    pids.add(row[1].split("pid=")[1].split(" ")[0])
names = {}
for p in pids:
    try:
        out = subprocess.check_output(f'tasklist /fi "PID eq {p}" /fo csv /nh', shell=True).decode(errors="ignore").split('","')[0].strip('"')
        names[p] = out
    except Exception: names[p] = "?"
for cov, line in sorted(rows, reverse=True):
    p = line.split("pid=")[1].split(" ")[0]
    print(line, "|", names.get(p, "?"))
