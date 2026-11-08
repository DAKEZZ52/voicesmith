"""生成 4 个图标草案（512px）+ 一张对比图。"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

OUT = r"E:\01-项目开发\GPT-SoVITS-desktop\docs\icon-drafts"
os.makedirs(OUT, exist_ok=True)
S = 512


def rounded_base(color_top, color_bottom):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = Image.new("RGB", (S, S), color_top)
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / S
        c = tuple(int(color_top[i] + (color_bottom[i] - color_top[i]) * t) for i in range(3))
        gd.line([(0, y), (S, y)], fill=c)
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([16, 16, S - 16, S - 16], radius=112, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


# A. 波束：橙色渐变 + 波形条
a = rounded_base((255, 154, 83), (235, 107, 32))
d = ImageDraw.Draw(a)
heights = [96, 176, 264, 200, 300, 216, 140]
bw, gap = 34, 22
total = len(heights) * bw + (len(heights) - 1) * gap
x = (S - total) // 2
for h in heights:
    y0 = (S - h) // 2
    d.rounded_rectangle([x, y0, x + bw, y0 + h], radius=17, fill=(255, 255, 255, 245))
    x += bw + gap
a.save(os.path.join(OUT, "A-wave.png"))

# B. 声弧：青蓝渐变 + 同心弧
b = rounded_base((56, 189, 248), (14, 116, 233))
d = ImageDraw.Draw(b)
cx, cy = S // 2, S // 2
for i, r in enumerate((70, 120, 170)):
    d.arc([cx - r, cy - r, cx + r, cy + r], start=-58, end=58, fill=(255, 255, 255, 90 + i * 60), width=26)
d.ellipse([cx - 34, cy - 34, cx + 34, cy + 34], fill=(255, 255, 255, 250))
b.save(os.path.join(OUT, "B-arc.png"))

# C. 声核：紫渐变 + 麦克风胶囊
c = rounded_base((167, 139, 250), (109, 40, 217))
d = ImageDraw.Draw(c)
d.rounded_rectangle([S // 2 - 52, 128, S // 2 + 52, 300], radius=52, fill=(255, 255, 255, 250))
d.arc([S // 2 - 110, 160, S // 2 + 110, 360], start=20, end=160, fill=(255, 255, 255, 235), width=22)
d.rounded_rectangle([S // 2 - 12, 360, S // 2 + 12, 420], radius=12, fill=(255, 255, 255, 235))
d.rounded_rectangle([S // 2 - 62, 418, S // 2 + 62, 444], radius=13, fill=(255, 255, 255, 235))
c.save(os.path.join(OUT, "C-mic.png"))

# D. 声纹：绿青渐变 + 指纹状波纹
e = rounded_base((52, 211, 153), (5, 150, 105))
d = ImageDraw.Draw(e)
cx, cy = S // 2, S // 2 + 10
for i in range(5):
    r = 50 + i * 32
    start = -40 + i * 14
    d.arc([cx - r, cy - r * 0.86, cx + r, cy + r * 0.86], start=start, end=180 - start,
          fill=(255, 255, 255, 235 - i * 22), width=20)
d.ellipse([cx - 18, cy - 18, cx + 18, cy + 18], fill=(255, 255, 255, 250))
e.save(os.path.join(OUT, "D-trace.png"))

# 对比图
names = ["A 波束 / wave", "B 声弧 / arc", "C 声核 / mic", "D 声纹 / trace"]
files = ["A-wave.png", "B-arc.png", "C-mic.png", "D-trace.png"]
sheet = Image.new("RGB", (1180, 720), (18, 20, 25))
sd = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("msyh.ttc", 30)
except Exception:
    font = ImageFont.load_default()
for i, (n, f) in enumerate(zip(names, files)):
    img = Image.open(os.path.join(OUT, f)).resize((250, 250))
    x = 60 + (i % 2) * 560
    y = 40 + (i // 2) * 340
    sheet.paste(img, (x, y), img)
    sd.text((x + 280, y + 100), n, fill=(230, 235, 245), font=font)
sheet.save(os.path.join(OUT, "sheet.png"))
print(os.path.join(OUT, "sheet.png"))
