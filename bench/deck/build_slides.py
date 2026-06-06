from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter


ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT = ROOT / "slides"
OUT.mkdir(parents=True, exist_ok=True)

W, H = 1920, 1080

FONT_REG = "C:/Windows/Fonts/segoeui.ttf"
FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_LIGHT = "C:/Windows/Fonts/segoeuil.ttf"
FONT_MONO = "C:/Windows/Fonts/CascadiaMono.ttf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=size)


F = {
    "title": font(FONT_BOLD, 92),
    "title_l": font(FONT_BOLD, 108),
    "subtitle": font(FONT_REG, 38),
    "body": font(FONT_REG, 31),
    "body_b": font(FONT_BOLD, 31),
    "small": font(FONT_REG, 22),
    "small_b": font(FONT_BOLD, 22),
    "mono": font(FONT_MONO, 23),
    "mono_l": font(FONT_MONO, 31),
    "kpi": font(FONT_BOLD, 74),
    "mega": font(FONT_BOLD, 168),
}

COL = {
    "ink": (8, 11, 16),
    "ink2": (13, 18, 26),
    "panel": (19, 27, 37),
    "panel2": (26, 37, 50),
    "line": (54, 75, 88),
    "muted": (139, 158, 166),
    "text": (237, 246, 241),
    "soft": (196, 215, 208),
    "mint": (156, 244, 194),
    "green": (66, 190, 137),
    "deep_green": (35, 111, 82),
    "cyan": (86, 224, 244),
    "amber": (255, 202, 99),
    "rose": (255, 93, 135),
    "violet": (176, 153, 255),
    "blue": (82, 138, 255),
    "white": (255, 255, 255),
}


def rgba(c, a=255):
    return (*c, a)


def make_canvas() -> Image.Image:
    img = Image.new("RGBA", (W, H), COL["ink"])
    px = img.load()
    for y in range(H):
        t = y / H
        base = (
            int(7 + 9 * t),
            int(11 + 13 * t),
            int(17 + 16 * t),
        )
        for x in range(W):
            v = int(7 * math.sin((x + y) / 180))
            px[x, y] = (max(0, base[0] + v), max(0, base[1] + v), max(0, base[2] + v), 255)
    return img


def draw_pixel_grid(draw: ImageDraw.ImageDraw, density=56, alpha=55):
    for x in range(80, W - 60, density):
        for y in range(70, H - 50, density):
            if (x // density + y // density) % 3 == 0:
                draw.rectangle([x, y, x + 3, y + 3], fill=rgba(COL["mint"], alpha))
            elif (x // density + y // density) % 5 == 0:
                draw.rectangle([x, y, x + 2, y + 2], fill=rgba(COL["cyan"], alpha // 2))


def draw_chrome(draw: ImageDraw.ImageDraw, slide_no: int, label: str):
    draw.text((88, 54), label.upper(), font=F["small_b"], fill=COL["mint"])
    draw.line((88, 91, W - 88, 91), fill=rgba(COL["line"], 150), width=1)
    no = f"{slide_no:02d}/06"
    bbox = draw.textbbox((0, 0), no, font=F["small_b"])
    draw.text((W - 88 - (bbox[2] - bbox[0]), 54), no, font=F["small_b"], fill=COL["muted"])


def text_size(draw, text, fnt):
    b = draw.textbbox((0, 0), text, font=fnt)
    return b[2] - b[0], b[3] - b[1]


def wrap_text(draw, text, fnt, max_w):
    words = text.split()
    lines = []
    cur = ""
    for w in words:
        candidate = w if not cur else f"{cur} {w}"
        if text_size(draw, candidate, fnt)[0] <= max_w:
            cur = candidate
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_wrapped(draw, xy, text, fnt, fill, max_w, line_gap=9):
    x, y = xy
    lines = wrap_text(draw, text, fnt, max_w)
    line_h = text_size(draw, "Hg", fnt)[1] + line_gap
    for i, line in enumerate(lines):
        draw.text((x, y + i * line_h), line, font=fnt, fill=fill)
    return y + len(lines) * line_h


def draw_pill(draw, x, y, text, fill, fg=COL["ink"], pad_x=18, pad_y=8, fnt=None):
    fnt = fnt or F["small_b"]
    tw, th = text_size(draw, text, fnt)
    r = 9
    draw.rounded_rectangle([x, y, x + tw + pad_x * 2, y + th + pad_y * 2], radius=r, fill=fill)
    draw.text((x + pad_x, y + pad_y - 1), text, font=fnt, fill=fg)
    return x + tw + pad_x * 2


def soft_rect(img, box, radius=20, fill=(255, 255, 255, 255), outline=None, width=1, shadow=True):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    if shadow:
        sx1, sy1, sx2, sy2 = box
        d.rounded_rectangle([sx1 + 8, sy1 + 12, sx2 + 8, sy2 + 12], radius=radius, fill=(0, 0, 0, 95))
        layer = layer.filter(ImageFilter.GaussianBlur(14))
        img.alpha_composite(layer)
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)
    img.alpha_composite(layer)


def mascot(size=360):
    src = Image.open(ASSETS / "forger-mascot.png").convert("RGBA")
    bbox = src.getbbox()
    src = src.crop(bbox)
    src.thumbnail((size, size), Image.Resampling.NEAREST)
    return src


def paste_mascot(img, x, y, size=360, alpha=255):
    m = mascot(size)
    if alpha != 255:
        a = m.getchannel("A").point(lambda p: int(p * alpha / 255))
        m.putalpha(a)
    img.alpha_composite(m, (x, y))


def draw_metric_bars(draw, x, y, values, max_value=100, width=560, height=28, gap=24):
    for i, (label, val, color) in enumerate(values):
        yy = y + i * (height + gap)
        draw.text((x, yy - 4), label, font=F["small_b"], fill=COL["soft"])
        bx = x + 230
        draw.rounded_rectangle([bx, yy, bx + width, yy + height], radius=height // 2, fill=rgba(COL["panel2"], 220))
        draw.rounded_rectangle([bx, yy, bx + int(width * val / max_value), yy + height], radius=height // 2, fill=color)
        pct = f"{val:.0f}"
        draw.text((bx + width + 20, yy - 6), pct, font=F["small_b"], fill=COL["text"])


def draw_arrow(draw, x1, y1, x2, y2, color, width=4):
    draw.line((x1, y1, x2, y2), fill=color, width=width)
    ang = math.atan2(y2 - y1, x2 - x1)
    for da in (2.55, -2.55):
        x = x2 + 18 * math.cos(ang + da)
        y = y2 + 18 * math.sin(ang + da)
        draw.line((x2, y2, x, y), fill=color, width=width)


def title(draw, txt, y=148, x=88, max_w=1240, size="title"):
    return draw_wrapped(draw, (x, y), txt, F[size], COL["text"], max_w, line_gap=7)


def slide_1():
    img = make_canvas()
    draw = ImageDraw.Draw(img)
    draw_pixel_grid(draw, density=52, alpha=48)

    # Huge quiet wordmark.
    draw.text((80, 770), "FORGER", font=font(FONT_BOLD, 210), fill=rgba(COL["white"], 15))
    draw.text((88, 126), "FORGER", font=F["title_l"], fill=COL["text"])
    draw.text((91, 244), "Optimization agent + benchmark for AI-generated app code", font=F["subtitle"], fill=COL["soft"])
    draw.line((92, 330, 920, 330), fill=COL["mint"], width=5)

    y = 390
    for label, copy, col in [
        ("forger-bench", "Mercury-style efficiency scoring for backend/frontend tasks", COL["cyan"]),
        ("forge-optimizer", "CUDA-Agent-inspired training loop for rewriting wasteful code", COL["mint"]),
        ("resource axis", "CPU, memory, disk/storage, rows, tokens, live 100k rows", COL["amber"]),
    ]:
        draw_pill(draw, 92, y, label, col, fg=COL["ink"])
        draw_wrapped(draw, (315, y + 4), copy, F["body"], COL["soft"], 840, 5)
        y += 70

    # Mascot on a lit slab.
    soft_rect(img, (1220, 250, 1712, 746), radius=34, fill=rgba((15, 35, 31), 185), outline=rgba(COL["mint"], 130), width=2)
    paste_mascot(img, 1272, 284, size=420)
    draw.text((1235, 780), "correct is table stakes", font=F["body_b"], fill=COL["mint"])
    draw.text((1235, 822), "efficient at scale is the score", font=F["body"], fill=COL["soft"])
    draw_chrome(draw, 1, "forge-optimizer / forger-bench")
    img.save(OUT / "slide_01_cover.png")


def slide_2():
    img = make_canvas()
    draw = ImageDraw.Draw(img)
    draw_pixel_grid(draw, density=58, alpha=38)
    draw_chrome(draw, 2, "the hidden failure mode")
    body_y = title(draw, "Correct app code can still be expensive code", max_w=1260) + 24
    draw_wrapped(
        draw,
        (92, body_y),
        "Functional tests miss the waste: over-fetched rows, N+1 backend calls, storage downloads, and one-at-a-time embeddings.",
        F["body"],
        COL["soft"],
        1120,
        10,
    )

    soft_rect(img, (110, 430, 850, 850), radius=24, fill=rgba((25, 24, 33), 220), outline=rgba(COL["rose"], 130), width=2)
    soft_rect(img, (1070, 430, 1810, 850), radius=24, fill=rgba((18, 36, 34), 220), outline=rgba(COL["mint"], 135), width=2)
    draw.text((144, 462), "naive agent output", font=F["body_b"], fill=COL["rose"])
    draw.text((1105, 462), "optimized target", font=F["body_b"], fill=COL["mint"])
    bad = [
        "const rows = await db.from('orders')",
        "  .select('*')",
        "const filtered = rows.data",
        "  .filter(r => r.user_id === uid)",
        "return filtered.slice(0, 20)",
    ]
    good = [
        "return db.from('orders')",
        "  .select('id,total,created_at')",
        "  .eq('user_id', uid)",
        "  .order('created_at', { ascending:false })",
        "  .range(0, 19)",
    ]
    for i, line in enumerate(bad):
        draw.text((146, 532 + i * 44), line, font=F["mono_l"], fill=COL["soft"])
    for i, line in enumerate(good):
        draw.text((1106, 532 + i * 44), line, font=F["mono_l"], fill=COL["soft"])
    draw_arrow(draw, 872, 640, 1048, 640, COL["amber"], width=7)
    draw.text((888, 595), "push work", font=F["small_b"], fill=COL["amber"])
    draw.text((895, 620), "to the backend", font=F["small_b"], fill=COL["amber"])

    draw_metric_bars(
        draw,
        560,
        900,
        [
            ("round trips", 85, COL["rose"]),
            ("bytes read", 78, COL["amber"]),
            ("rows scanned", 92, COL["rose"]),
        ],
        width=500,
        height=22,
        gap=18,
    )
    draw.text((92, 902), "forger-bench catches the waste", font=F["body_b"], fill=COL["text"])
    img.save(OUT / "slide_02_correct_but_wasteful.png")


def slide_3():
    img = make_canvas()
    draw = ImageDraw.Draw(img)
    draw_pixel_grid(draw, density=50, alpha=45)
    draw_chrome(draw, 3, "benchmark substrate")
    body_y = title(draw, "forger-bench is Mercury for backend/frontend dev", max_w=1300) + 24
    draw_wrapped(
        draw,
        (92, body_y),
        "Instead of LeetCode CPU runtime, the benchmark scores the app cost model: calls, bytes, rows, storage, tokens, wall time, and memory.",
        F["body"],
        COL["soft"],
        1160,
        10,
    )

    # KPI strip, open typography rather than cards.
    kpis = [("52", "tasks"), ("39", "sealed test"), ("13", "concepts"), ("5", "domains")]
    x = 98
    for n, lab in kpis:
        draw.text((x, 405), n, font=F["mega"], fill=COL["mint"])
        draw.text((x + 12, 588), lab, font=F["body_b"], fill=COL["soft"])
        x += 270

    # Metric basket.
    basket = [
        ("dbOps", COL["cyan"]),
        ("bytesRead", COL["mint"]),
        ("rowsScanned", COL["amber"]),
        ("storageBytes", COL["violet"]),
        ("aiTokens", COL["rose"]),
        ("wallMs", COL["blue"]),
        ("peakRSS", COL["green"]),
        ("disk/storage", COL["amber"]),
    ]
    cx, cy = 1390, 600
    draw.ellipse([cx - 135, cy - 135, cx + 135, cy + 135], fill=rgba((23, 39, 42), 230), outline=rgba(COL["mint"], 120), width=2)
    draw.text((cx - 70, cy - 28), "cost", font=F["title"], fill=COL["text"])
    draw.text((cx - 68, cy + 58), "basket", font=F["body_b"], fill=COL["mint"])
    for i, (lab, col) in enumerate(basket):
        a = -math.pi / 2 + i * 2 * math.pi / len(basket)
        x = cx + int(math.cos(a) * 315)
        y = cy + int(math.sin(a) * 245)
        draw.line((cx + int(math.cos(a) * 150), cy + int(math.sin(a) * 150), x, y), fill=rgba(col, 150), width=2)
        w, h = text_size(draw, lab, F["small_b"])
        draw.rounded_rectangle([x - w / 2 - 14, y - 17, x + w / 2 + 14, y + 19], radius=8, fill=rgba(COL["panel2"], 235), outline=rgba(col, 180))
        draw.text((x - w / 2, y - 14), lab, font=F["small_b"], fill=col)

    draw.text((92, 770), "Score = correctness gate + percentile vs oracle/mid/naive spread", font=F["body_b"], fill=COL["text"])
    draw.text((92, 817), "Every task has calibrated reference solutions, sealed test entities, and contamination checks.", font=F["body"], fill=COL["soft"])
    paste_mascot(img, 1620, 825, size=145, alpha=225)
    img.save(OUT / "slide_03_forger_bench.png")


def slide_4():
    img = make_canvas()
    draw = ImageDraw.Draw(img)
    draw_pixel_grid(draw, density=64, alpha=34)
    draw_chrome(draw, 4, "what the benchmark exposed")
    body_y = title(draw, "The request-cost score was not the hard bar", max_w=1300) + 24
    draw_wrapped(
        draw,
        (92, body_y),
        "On toy-sized request-cost tests, frontier agents look strong. Under concurrent live load against 100k-row tables, their resource scores collapse to the low 50s.",
        F["body"],
        COL["soft"],
        1120,
        10,
    )

    # Grouped bar chart.
    x0, y0 = 180, 765
    chart_w, chart_h = 1070, 350
    draw.line((x0, y0, x0 + chart_w, y0), fill=COL["line"], width=2)
    for tick in [0, 25, 50, 75, 100]:
        x = x0 + chart_w * tick / 100
        draw.line((x, y0, x, y0 - chart_h), fill=rgba(COL["line"], 80), width=1)
        draw.text((x - 16, y0 + 14), str(tick), font=F["small"], fill=COL["muted"])
    rows = [
        ("codex", 87.18, 54.16),
        ("claude", 82.05, 54.07),
        ("qwen base", 56.34, 25.00),
    ]
    for i, (name, req, res) in enumerate(rows):
        yy = y0 - chart_h + 54 + i * 96
        draw.text((x0 - 112, yy + 10), name, font=F["small_b"], fill=COL["soft"])
        draw.rounded_rectangle([x0, yy, x0 + chart_w * req / 100, yy + 25], radius=12, fill=COL["cyan"])
        draw.rounded_rectangle([x0, yy + 35, x0 + chart_w * res / 100, yy + 60], radius=12, fill=COL["amber"])
        draw.text((x0 + chart_w * req / 100 + 12, yy - 2), f"{req:.0f}", font=F["small_b"], fill=COL["cyan"])
        draw.text((x0 + chart_w * res / 100 + 12, yy + 33), f"{res:.0f}", font=F["small_b"], fill=COL["amber"])
    draw_pill(draw, 745, 805, "request-cost", COL["cyan"])
    draw_pill(draw, 930, 805, "live resource", COL["amber"])

    soft_rect(img, (1330, 400, 1785, 785), radius=26, fill=rgba((35, 24, 31), 225), outline=rgba(COL["rose"], 135), width=2)
    draw.text((1362, 432), "scale trap", font=F["body_b"], fill=COL["rose"])
    draw.text((1362, 492), "fetch all rows", font=F["body_b"], fill=COL["text"])
    draw.text((1362, 534), "then process in JS", font=F["body"], fill=COL["soft"])
    draw.text((1362, 614), "PostgREST cap:", font=F["body_b"], fill=COL["amber"])
    draw.text((1362, 654), "1000 rows", font=F["kpi"], fill=COL["amber"])
    draw_wrapped(draw, (1362, 742), "A cheap-looking result can be wrong at 100k rows.", F["small_b"], COL["soft"], 350, 7)

    draw.text((92, 902), "AI and auth are systematic weak spots; the resource axis turns hidden waste into a training signal.", font=F["body_b"], fill=COL["text"])
    img.save(OUT / "slide_04_results_gap.png")


def slide_5():
    img = make_canvas()
    draw = ImageDraw.Draw(img)
    draw_pixel_grid(draw, density=52, alpha=42)
    draw_chrome(draw, 5, "precedent: cuda-agent")
    body_y = title(draw, "CUDA-Agent: measured execution feedback", max_w=1500) + 24
    draw_wrapped(
        draw,
        (92, body_y),
        "The useful idea is not CUDA-specific: make the model act, run the artifact, verify it, profile it, and feed the measured result back into the next attempt.",
        F["body"],
        COL["soft"],
        1160,
        10,
    )

    nodes = [
        ("write kernel", 330, 615, COL["mint"]),
        ("compile/run", 675, 525, COL["cyan"]),
        ("verify", 1040, 615, COL["amber"]),
        ("profile", 675, 760, COL["violet"]),
    ]
    for label, x, y, col in nodes:
        draw.ellipse([x - 108, y - 78, x + 108, y + 78], fill=rgba(COL["panel2"], 235), outline=rgba(col, 180), width=3)
        w, _ = text_size(draw, label, F["body_b"])
        draw.text((x - w / 2, y - 20), label, font=F["body_b"], fill=col)
    draw_arrow(draw, 438, 590, 575, 550, COL["line"], 5)
    draw_arrow(draw, 783, 550, 934, 590, COL["line"], 5)
    draw_arrow(draw, 1000, 690, 790, 755, COL["line"], 5)
    draw_arrow(draw, 570, 752, 405, 675, COL["line"], 5)
    draw.text((520, 640), "execution loop", font=F["title"], fill=rgba(COL["white"], 35))

    soft_rect(img, (1280, 395, 1770, 800), radius=26, fill=rgba((18, 28, 43), 228), outline=rgba(COL["cyan"], 120), width=2)
    draw.text((1315, 430), "training ingredients", font=F["body_b"], fill=COL["cyan"])
    bullets = [
        "discrete milestone reward",
        "multi-stage warm-up before RL",
        "anti-hack guards",
        "profile output as observation",
    ]
    y = 500
    for b in bullets:
        draw.rectangle([1318, y + 13, 1330, y + 25], fill=COL["mint"])
        draw.text((1350, y), b, font=F["body"], fill=COL["soft"])
        y += 61

    draw.text((92, 900), "Slide 5: CUDA-Agent is the template for agentic optimization, not the final domain.", font=F["body_b"], fill=COL["text"])
    img.save(OUT / "slide_05_cuda_agent.png")


def slide_6():
    img = make_canvas()
    draw = ImageDraw.Draw(img)
    draw_pixel_grid(draw, density=48, alpha=48)
    draw_chrome(draw, 6, "novel adaptation")
    body_y = title(draw, "forge-optimizer adapts the loop to backend/frontend tasks", max_w=1420) + 24
    draw_wrapped(
        draw,
        (92, body_y),
        "The model is trained to rewrite unoptimized coding-agent output into InsForge code that is correct, cheap, and scale-safe.",
        F["body"],
        COL["soft"],
        1160,
        10,
    )

    # Pipeline.
    boxes = [
        ("unoptimized\nagent code", 120, 445, COL["rose"]),
        ("forger-bench\ngrader", 505, 445, COL["cyan"]),
        ("structured\nobservation", 890, 445, COL["amber"]),
        ("Qwen3.6 MoE\nLoRA + GRPO", 1275, 445, COL["mint"]),
    ]
    for txt, x, y, col in boxes:
        soft_rect(img, (x, y, x + 270, y + 150), radius=20, fill=rgba(COL["panel"], 230), outline=rgba(col, 165), width=2, shadow=False)
        lines = txt.split("\n")
        for j, line in enumerate(lines):
            tw, _ = text_size(draw, line, F["body_b"])
            draw.text((x + 135 - tw / 2, y + 42 + j * 38), line, font=F["body_b"], fill=col if j == 0 else COL["soft"])
    for x in [390, 775, 1160]:
        draw_arrow(draw, x, 520, x + 95, 520, COL["line"], 5)

    # Reward ladder.
    draw.text((120, 670), "milestone reward", font=F["body_b"], fill=COL["text"])
    reward = [
        ("-1", "wrong or scaleBug", COL["rose"]),
        ("1", "correct but wasteful", COL["amber"]),
        ("2", "beats naive", COL["cyan"]),
        ("3", "oracle-class", COL["mint"]),
    ]
    x = 120
    for n, lab, col in reward:
        draw.rounded_rectangle([x, 724, x + 330, 815], radius=18, fill=rgba(COL["panel2"], 235), outline=rgba(col, 155), width=2)
        draw.text((x + 22, 737), n, font=F["kpi"], fill=col)
        draw_wrapped(draw, (x + 110, 747), lab, F["small_b"], COL["soft"], 190, 5)
        x += 360

    # Rig + output.
    soft_rect(img, (1230, 835, 1785, 985), radius=24, fill=rgba((16, 36, 31), 225), outline=rgba(COL["mint"], 130), width=2)
    draw.text((1260, 862), "run target", font=F["small_b"], fill=COL["mint"])
    draw.text((1260, 900), "RTX PRO 6000 96GB + Unsloth", font=F["body_b"], fill=COL["text"])
    draw.text((1260, 942), "SFT -> RFT -> agentic GRPO", font=F["body"], fill=COL["soft"])

    paste_mascot(img, 1580, 620, size=250, alpha=245)
    draw.text((92, 922), "Goal: beat frontier agents on sealed tests and live resource scoring.", font=F["body_b"], fill=COL["text"])
    img.save(OUT / "slide_06_forge_optimizer.png")


def montage():
    files = sorted(OUT.glob("slide_*.png"))
    thumbs = []
    for p in files:
        im = Image.open(p).convert("RGB")
        im.thumbnail((480, 270), Image.Resampling.LANCZOS)
        thumbs.append((p.name, im.copy()))
    sheet = Image.new("RGB", (1000, 900), (12, 16, 22))
    d = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(thumbs):
        x = 20 + (i % 2) * 490
        y = 20 + (i // 2) * 290
        sheet.paste(im, (x, y))
        d.text((x, y + 274), name, font=F["small"], fill=COL["soft"])
    sheet.save(OUT / "montage.png")


def main():
    slide_1()
    slide_2()
    slide_3()
    slide_4()
    slide_5()
    slide_6()
    montage()
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
