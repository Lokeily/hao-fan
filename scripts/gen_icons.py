#!/usr/bin/env python3
"""生成「好翻」品牌图标（带圆角底色 + 白色「好翻」字样）。

依赖 Pillow：在托管 Python 的 venv 中 `pip install Pillow` 后运行。
若无中文字体或 Pillow 不可用，则退回纯色方块。
"""
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'public')
os.makedirs(OUT, exist_ok=True)

BG = (79, 156, 249)   # #4f9cf9
FG = (255, 255, 255)

FONT_CANDIDATES = [
    r'C:\Windows\Fonts\msyh.ttc',
    r'C:\Windows\Fonts\msyhbd.ttc',
    r'C:\Windows\Fonts\simhei.ttf',
    r'C:\Windows\Fonts\simsun.ttc',
    r'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]
FONT_PATH = next((f for f in FONT_CANDIDATES if os.path.exists(f)), None)


def make(size):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = max(2, int(size * 0.22))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)

    text = '好翻'
    fs = int(size * 0.52)
    try:
        if FONT_PATH and FONT_PATH.lower().endswith('.ttc'):
            font = ImageFont.truetype(FONT_PATH, fs, index=0)
        elif FONT_PATH:
            font = ImageFont.truetype(FONT_PATH, fs)
        else:
            font = ImageFont.load_default()
    except Exception:
        font = ImageFont.load_default()

    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if tw > size * 0.92:
        fs = int(fs * size * 0.92 / tw)
        try:
            if FONT_PATH and FONT_PATH.lower().endswith('.ttc'):
                font = ImageFont.truetype(FONT_PATH, fs, index=0)
            elif FONT_PATH:
                font = ImageFont.truetype(FONT_PATH, fs)
            else:
                font = ImageFont.load_default()
        except Exception:
            font = ImageFont.load_default()
        bbox = d.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]

    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    d.text((x, y), text, font=font, fill=FG)
    img.save(os.path.join(OUT, f'icon-{size}.png'))


for s in (16, 48, 128):
    make(s)

print('icons generated:', sorted(os.listdir(OUT)))
