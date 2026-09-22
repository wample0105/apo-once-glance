import io, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import ImageGrab

im = ImageGrab.grab().convert("L").resize((160, 100))
d = list(im.getdata())
print(sum(d) // len(d))
