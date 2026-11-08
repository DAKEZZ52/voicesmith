"""声匠 VoiceSmith 图标：橙色渐变 + 声纹弧。生成 build/icon.ico 与 docs/icon.png。"""
import os

from PIL import Image, ImageDraw

S = 1024
OUT_DIR = r"E:\01-项目开发\GPT-SoVITS-desktop"
os.makedirs(os.path.join(OUT_DIR, "build"), exist_ok=True)
os.makedirs(os.path.join(OUT_DIR, "docs"), exist_ok=True)

# 橙色渐变圆角底
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
grad = Image.new("RGB", (S, S))
gd = ImageDraw.Draw(grad)
top = (255, 163, 94)
bot = (226, 96, 30)
for y in range(S):
    t = y / S
    gd.line([(0, y), (S, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([28, 28, S - 28, S - 28], radius=224, fill=255)
img.paste(grad, (0, 0), mask)

import math
d = ImageDraw.Draw(img)
cx, cy = S // 2, S // 2
N = 40
base_r = 168
for i in range(N):
    ang = (i / N) * math.tau - math.pi / 2
    # 环形波形：低频 + 高频叠加，做出"说话"的起伏
    amp = 62 + 120 * (0.55 + 0.45 * math.sin(i * 0.9)) * (0.6 + 0.4 * math.cos(i * 0.37 + 1.2))
    r0 = base_r
    r1 = base_r + amp
    x0, y0 = cx + r0 * math.cos(ang), cy + r0 * math.sin(ang)
    x1, y1 = cx + r1 * math.cos(ang), cy + r1 * math.sin(ang)
    d.line([x0, y0, x1, y1], fill=(255, 255, 255, 255), width=26)
    d.ellipse([x1 - 13, y1 - 13, x1 + 13, y1 + 13], fill=(255, 255, 255, 255))
    d.ellipse([x0 - 13, y0 - 13, x0 + 13, y0 + 13], fill=(255, 255, 255, 255))
d.ellipse([cx - 62, cy - 62, cx + 62, cy + 62], fill=(255, 255, 255, 255))
img.save(os.path.join(OUT_DIR, "docs", "icon.png"))
img.resize((512, 512), Image.LANCZOS).save(
    os.path.join(OUT_DIR, "build", "icon.ico"),
    sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print("ok")
