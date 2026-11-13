from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).with_suffix('.png')
SVG = Path(__file__).with_suffix('.svg')
W, H = 1800, 1280
BG = '#09131f'
CARD = '#101c2b'
GRID = '#293c4d'
TEXT = '#e8edf4'
MUTED = '#9eafc3'
PURPLE = '#a66bff'
GREEN = '#25d4a7'
WHITE = '#f3f6fb'

font_candidates = [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
]
def font(size):
    for p in font_candidates:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size, index=0)
            except Exception:
                pass
    return ImageFont.load_default()

F_KICK = font(42)
F_TITLE = font(62)
F_SUB = font(32)
F_HEAD = font(30)
F_LABEL = font(31)
F_VALUE = font(38)
F_SMALL = font(25)
F_NOTE = font(24)

def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

def centered(draw, xy, text, fnt, fill):
    box = draw.textbbox((0, 0), text, font=fnt)
    draw.text((xy[0] - (box[2]-box[0])/2, xy[1] - (box[3]-box[1])/2), text, font=fnt, fill=fill)

def fmt_sec(v):
    m, s = divmod(round(v), 60)
    return f'{m}分{s:02d}秒'

def svg_text(x, y, text, size, fill, anchor='start', weight=400):
    esc = text.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
    return f'<text x="{x}" y="{y}" font-family="-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif" font-size="{size}px" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{esc}</text>'

rows = [
    ('任务完成', '20/20', '20/20', ''),
    ('浏览器验收', '59/59', '59/59', ''),
    ('墙钟（20题合计）', fmt_sec(2657.8), fmt_sec(2608.4), '-1.9%'),
    ('平均题末上下文', '64,290', '62,838', '-2.3%'),
    ('第 20 题结束上下文', '103,360', '102,061', '-1.3%'),
    ('最高题末上下文', '124,597', '117,432', '-5.8%'),
    ('末步缓存命中率*', '98.3245%', '98.2054%', '-0.12 pp'),
    ('CUT 现场统计', '不适用', '未采集', ''),
]

im = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(im)
# subtle background glow bands
for i in range(24):
    shade = (9 + i//4, 19 + i//5, 31 + i//4)
    d.rounded_rectangle((30+i*3, 30+i*2, W-30-i*3, H-30-i*2), radius=48, outline=shade, width=1)
rounded(d, (54, 54, W-54, H-54), 42, CARD, '#2b4054', 2)
# purple top rule
for x in range(72, W-72):
    t = (x-72)/(W-144)
    r = int(135 + 75*t); g = int(74 + 40*t); b = int(255 - 20*t)
    d.line((x, 70, x+1, 78), fill=(r,g,b), width=8)

left = 116
center_o = 1090
center_l = 1490
# header
centered(d, (left+160, 150), '长任务 · 20 题', F_KICK, PURPLE)
d.text((left, 205), 'Web-Bench React 20', font=F_TITLE, fill=WHITE)
d.text((left, 286), 'GLM-5.3 Flash · 原版 DSH vs Live Compact', font=F_SUB, fill=MUTED)
d.text((left, 335), '同一 fixture · 20 个任务 · 只比较实际可回读的运行指标', font=F_SMALL, fill=MUTED)
# headers
header_y = 430
centered(d, (left+130, header_y), '指标', F_HEAD, MUTED)
centered(d, (center_o, header_y), '原版', F_HEAD, MUTED)
centered(d, (center_l, header_y), 'Live Compact', F_HEAD, GREEN)
d.line((left, 470, W-left, 470), fill=GRID, width=2)

row_y = 500
row_h = 72
for idx, (label, original, live, delta) in enumerate(rows):
    y = row_y + idx*row_h
    d.line((left, y+42, W-left, y+42), fill=GRID, width=1)
    d.text((left, y), label, font=F_LABEL, fill=TEXT)
    centered(d, (center_o, y+16), original, F_VALUE, WHITE)
    centered(d, (center_l, y+16), live, F_VALUE, GREEN if live not in ('20/20','59/59','未采集') else WHITE)
    if delta:
        centered(d, (center_l+190, y+16), delta, F_SMALL, GREEN)
# footnote panel
note_y = row_y + len(rows)*row_h + 35
rounded(d, (left, note_y, W-left, H-75), 18, '#0d1826', '#203448', 1)
d.text((left+24, note_y+20), '* 末步缓存命中率沿用两份 run report 的原始字段。', font=F_NOTE, fill=MUTED)
d.text((left+24, note_y+58), 'Live Compact 这次报告未生成有效 spine stats，CUT 不写成 0；图中只展示可独立核对的任务、上下文和缓存结果。', font=F_NOTE, fill=MUTED)
# save
im.save(OUT, quality=95)

# companion SVG source with the same layout, suitable for browser/release attachment
parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
         f'<rect width="{W}" height="{H}" fill="{BG}"/>',
         f'<rect x="54" y="54" width="{W-108}" height="{H-108}" rx="42" fill="{CARD}" stroke="#2b4054" stroke-width="2"/>',
         f'<rect x="72" y="70" width="{W-144}" height="8" rx="4" fill="url(#top)"/>',
         '<defs><linearGradient id="top" x1="0" x2="1"><stop stop-color="#874aff"/><stop offset="1" stop-color="#d47bff"/></linearGradient></defs>']
parts += [svg_text(left+160, 165, '长任务 · 20 题', 42, PURPLE, 'middle', 600), svg_text(left, 258, 'Web-Bench React 20', 62, WHITE, 'start', 700), svg_text(left, 320, 'GLM-5.3 Flash · 原版 DSH vs Live Compact', 32, MUTED), svg_text(left, 360, '同一 fixture · 20 个任务 · 只比较实际可回读的运行指标', 25, MUTED)]
parts += [svg_text(left+130, 446, '指标', 30, MUTED, 'middle', 600), svg_text(center_o, 446, '原版', 30, MUTED, 'middle', 600), svg_text(center_l, 446, 'Live Compact', 30, GREEN, 'middle', 600), f'<line x1="{left}" y1="470" x2="{W-left}" y2="470" stroke="{GRID}" stroke-width="2"/>']
for idx, (label, original, live, delta) in enumerate(rows):
    y = row_y + idx*row_h
    parts += [f'<line x1="{left}" y1="{y+42}" x2="{W-left}" y2="{y+42}" stroke="{GRID}"/>', svg_text(left, y+15, label, 31, TEXT), svg_text(center_o, y+30, original, 38, WHITE, 'middle', 500), svg_text(center_l, y+30, live, 38, GREEN if live not in ('20/20','59/59','未采集') else WHITE, 'middle', 600)]
    if delta: parts.append(svg_text(center_l+190, y+30, delta, 25, GREEN, 'middle', 500))
parts += [f'<rect x="{left}" y="{note_y}" width="{W-2*left}" height="{H-75-note_y}" rx="18" fill="#0d1826" stroke="#203448"/>', svg_text(left+24, note_y+48, '* 末步缓存命中率沿用两份 run report 的原始字段。', 24, MUTED), svg_text(left+24, note_y+86, 'Live Compact 这次报告未生成有效 spine stats，CUT 不写成 0；图中只展示可独立核对的任务、上下文和缓存结果。', 24, MUTED), '</svg>']
SVG.write_text('\n'.join(parts))
print(OUT)
print(SVG)
print(im.size)
