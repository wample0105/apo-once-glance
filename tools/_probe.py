# 临时 UI 探针：模拟键盘鼠标 + 截屏（验证后可删）
import ctypes, time, sys
from PIL import ImageGrab

u32 = ctypes.windll.user32
PUL = ctypes.POINTER(ctypes.c_ulong)

# DPI 感知：让 GetSystemMetrics/坐标空间与物理像素(截图)一致，否则 150% 缩放下点击错位
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    ctypes.windll.user32.SetProcessDPIAware()

class KI(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong),
                ("dwExtraInfo", PUL)]

class MI(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long), ("mouseData", ctypes.c_ulong),
                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong), ("dwExtraInfo", PUL)]

class INP(ctypes.Structure):
    class U(ctypes.Union):
        _fields_ = [("ki", KI), ("mi", MI)]
    _anonymous_ = ("u",)
    _fields_ = [("type", ctypes.c_ulong), ("u", U)]

INP_KEYBOARD, INP_MOUSE = 1, 0
KEYUP = 2
MOUSEEVENTF_MOVE = 1
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 2
MOUSEEVENTF_LEFTUP = 4

def key(vk, up=False):
    i = INP(type=INP_KEYBOARD)
    i.ki = KI(vk, 0, KEYUP if up else 0, 0, None)
    u32.SendInput(1, ctypes.byref(i), ctypes.sizeof(i))

def tap(vk, delay=0.03):
    key(vk); time.sleep(delay); key(vk, True); time.sleep(delay)

def to_abs(x, y):
    sx = u32.GetSystemMetrics(0); sy = u32.GetSystemMetrics(1)
    return (int(x * 65535 / (sx - 1)), int(y * 65535 / (sy - 1)))

def move_to(x, y):
    ax, ay = to_abs(x, y)
    i = INP(type=INP_MOUSE)
    i.mi = MI(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, None)
    u32.SendInput(1, ctypes.byref(i), ctypes.sizeof(i))
    time.sleep(0.02)

def btn(down):
    i = INP(type=INP_MOUSE)
    i.mi = MI(0, 0, 0, MOUSEEVENTF_LEFTDOWN if down else MOUSEEVENTF_LEFTUP, 0, None)
    u32.SendInput(1, ctypes.byref(i), ctypes.sizeof(i))

def drag(x1, y1, x2, y2, steps=25):
    move_to(x1, y1); time.sleep(0.15)
    btn(True); time.sleep(0.12)
    for s in range(1, steps + 1):
        move_to(x1 + (x2 - x1) * s / steps, y1 + (y2 - y1) * s / steps)
        time.sleep(0.012)
    time.sleep(0.1)
    btn(False); time.sleep(0.25)

def click(x, y):
    move_to(x, y); time.sleep(0.12)
    btn(True); time.sleep(0.06); btn(False); time.sleep(0.2)

MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 8, 16
def rbtn(down):
    i = INP(type=INP_MOUSE)
    i.mi = MI(0, 0, 0, MOUSEEVENTF_RIGHTDOWN if down else MOUSEEVENTF_RIGHTUP, 0, None)
    u32.SendInput(1, ctypes.byref(i), ctypes.sizeof(i))

def rclick(x, y):
    move_to(x, y); time.sleep(0.12)
    rbtn(True); time.sleep(0.06); rbtn(False); time.sleep(0.2)

def keychar(ch):
    # 依据字符推 VK（字母/数字）
    vk = ord(ch.upper()) if ch.isalnum() else None
    if vk: tap(vk)

def shot(name):
    time.sleep(0.35)
    img = ImageGrab.grab()
    img.save(name)
    print("saved", name, img.size)

def esc_region_hotkey():
    # Alt+Shift+A = 0x12/0x10/0x41
    key(0x12); key(0x10); tap(0x41); key(0x10, True); key(0x12, True)

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "start":
        esc_region_hotkey()
        time.sleep(1.2)
        drag(600, 400, 1600, 1000)
        shot(sys.argv[2] if len(sys.argv) > 2 else "probe_1_toolbar.png")
    elif cmd == "restart":
        tap(0x1B); time.sleep(0.4)  # 关掉可能开着的覆盖层
        esc_region_hotkey()
        time.sleep(1.2)
        drag(600, 400, 1600, 1000)
        shot(sys.argv[2] if len(sys.argv) > 2 else "probe_restart.png")
    elif cmd == "shot":
        shot(sys.argv[2])
    elif cmd == "click":
        click(int(sys.argv[2]), int(sys.argv[3]))
        shot(sys.argv[4])
    elif cmd == "drag":
        drag(int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]))
        shot(sys.argv[6])
    elif cmd == "key":
        tap(int(sys.argv[2]))
        shot(sys.argv[3])
    elif cmd == "esc":
        tap(0x1B)
        shot(sys.argv[2])
