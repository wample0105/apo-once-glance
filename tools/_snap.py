# 输出定影取景窗口诊断快照 JSON：{"found":bool,"on_screen":bool,"x":int,"y":int,"lay":bool,"trn":bool,"top":bool,"lum":int}
import ctypes, json
from ctypes import wintypes
import PIL.ImageGrab

user32 = ctypes.windll.user32
hwnd_found = None
@ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND)
def cb(hwnd):
    global hwnd_found
    if not user32.IsWindowVisible(hwnd): return True
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buf, 256)
    if buf.value == "\u5b9a\u5f71\u53d6\u666f":
        hwnd_found = hwnd
    return True
user32.EnumWindows(cb, 0)
if not hwnd_found:
    print(json.dumps({"found": False})); raise SystemExit(0)
r = wintypes.RECT()
user32.GetWindowRect(hwnd_found, ctypes.byref(r))
ex = user32.GetWindowLongW(hwnd_found, -20) & 0xFFFFFFFF
im = PIL.ImageGrab.grab().convert("L").resize((160, 100))
d = list(im.getdata())
print(json.dumps({"found": True, "x": r.left, "y": r.top, "w": r.right-r.left, "h": r.bottom-r.top,
                  "lay": bool(ex & 0x80000), "trn": bool(ex & 0x20), "top": bool(ex & 0x8),
                  "lum": sum(d)//len(d)}))
