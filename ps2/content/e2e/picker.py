import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB'); w, h = im.size
# Region where P1's costume boxes (1 2 3) appear; the grid shows sepia portraits there instead.
box = im.crop((int(w*0.22), int(h*0.63), int(w*0.48), int(h*0.72)))
px = list(box.get_flattened_data()) if hasattr(box, "get_flattened_data") else list(box.getdata())
white = sum(1 for r, g, b in px if r > 200 and g > 200 and b > 190) / len(px)
print(f"{white:.3f}")
