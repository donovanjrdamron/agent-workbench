#!/usr/bin/env python3
"""Studio's photo grade: reads a picture on stdin and the settings as JSON (argv[1]), writes the graded picture to stdout.
The colour math is grade_pipeline.py (the brand-photo-grade skill's own). The output is a fresh file: no EXIF, no XMP,
no C2PA or other metadata from the original (it is never copied over). Needs numpy and Pillow."""
import io, json, sys
from PIL import Image, ImageOps
sys.path.insert(0, __import__("os").path.dirname(__file__))
from grade_pipeline import GradeRecipe, apply_recipe

def main():
    g = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    img = Image.open(io.BytesIO(sys.stdin.buffer.read()))
    img = ImageOps.exif_transpose(img)              # keep the picture the right way up once its EXIF is gone
    if img.mode not in ("RGB", "RGBA"): img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    m = int(g.get("max") or 0)
    if m and max(img.size) > m: img.thumbnail((m, m), Image.LANCZOS)   # (the quick preview)
    t3 = lambda k: tuple(float(x) for x in (g.get(k) or [0, 0, 0]))[:3]
    hue = []
    for key, centre, width in (("reds", 0, 25), ("blues", 220, 35), ("greens", 120, 40)):
        v = float(g.get(key, 1))
        if abs(v - 1) > 1e-3: hue.append((centre, width, v))
    r = GradeRecipe(
        name="studio", intensity=float(g.get("intensity", 1)),
        shadow_rgb=t3("shadow"), mid_rgb=t3("mid"), high_rgb=t3("high"), hue_adjustments=hue,
        contrast_amount=float(g.get("contrast", 0)),
        vignette_strength=float(g["vignette"]) if float(g.get("vignette") or 0) > 0 else None,
        grain_intensity=float(g.get("grain", 0)) * (img.size[0] / g["fullw"] if g.get("fullw") and m else 1),
        halation_strength=float(g["halation"]) if float(g.get("halation") or 0) > 0 else None,
    )
    out = apply_recipe(img, r) if g.get("grade", True) else img
    buf = io.BytesIO()
    if out.mode == "RGBA" and out.getextrema()[3][0] < 255: out.save(buf, "PNG", optimize=True)          # keeps transparency
    else: out.convert("RGB").save(buf, "JPEG", quality=int(g.get("quality", 95)), optimize=True, subsampling=0)
    sys.stdout.buffer.write(buf.getvalue())

main()
