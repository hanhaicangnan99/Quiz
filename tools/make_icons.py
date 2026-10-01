# -*- coding: utf-8 -*-
"""生成扩展图标 icons/icon16.png、icon48.png、icon128.png。

用法：python tools\\make_icons.py
优先用系统中文字体绘制「答」字；字体不可用时退化为几何图形（对勾），不阻断。
"""

from __future__ import print_function

import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
ICONS = os.path.join(APP, "icons")

BG = (20, 108, 148, 255)      # #146c94
FG = (255, 255, 255, 255)
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]
SIZES = [16, 48, 128, 192, 512]          # 扩展用 16/48/128，PWA 用 192/512
MASKABLE = 512                            # 额外生成一张自适应图标（Android 会裁剪）


def rounded_background(size):
    img = Image.new("RGBA", (size * 4, size * 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = int(size * 4 * 0.22)
    d.rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius=radius, fill=BG)
    return img.resize((size, size), Image.LANCZOS)


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size), True
            except Exception:
                continue
    return ImageFont.load_default(), False


def draw_check(d, size):
    w = max(2, size // 9)
    d.line([(size * 0.26, size * 0.52), (size * 0.44, size * 0.70), (size * 0.76, size * 0.32)],
           fill=FG, width=w, joint="curve")


def make_icon(size, maskable=False):
    scale = 4
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        # 自适应图标：满幅背景、去掉圆角，图形缩到安全区内，避免被系统裁掉
        d.rectangle([0, 0, big - 1, big - 1], fill=BG)
        box = 0.54
    else:
        radius = int(big * 0.22)
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=BG)
        box = 0.62
    font, has_cjk = load_font(int(big * box))
    if has_cjk:
        try:
            d.text((big / 2, big / 2 - big * 0.02), u"\u7b54", font=font, fill=FG, anchor="mm")
        except Exception:
            has_cjk = False
    if not has_cjk:
        draw_check(d, big)
    return img.resize((size, size), Image.LANCZOS)


def main():
    if not os.path.isdir(ICONS):
        os.makedirs(ICONS)
    font, has_cjk = load_font(40)
    for size in SIZES:
        path = os.path.join(ICONS, "icon%d.png" % size)
        make_icon(size).save(path, "PNG")
        print("written %s" % os.path.basename(path))
    mask_path = os.path.join(ICONS, "icon%d-maskable.png" % MASKABLE)
    make_icon(MASKABLE, maskable=True).save(mask_path, "PNG")
    print("written %s" % os.path.basename(mask_path))
    print("font-ok=%s" % has_cjk)
    return 0


if __name__ == "__main__":
    sys.exit(main())
