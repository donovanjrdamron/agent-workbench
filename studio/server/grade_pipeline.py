"""
Brand Photo Grade — core pipeline implementation.

This module contains the eight color-math primitives that compose into a brand grade,
plus a Grade class that runs a recipe end-to-end.

The pipeline is pure NumPy + PIL. No CV/ML dependencies.

Order of operations within Grade.apply():
    1. Lift or crush blacks (if specified)
    2. Three-way color grade
    3. Selective hue saturation adjustments
    4. S-curve contrast
    5. Roll highlights (if specified)
    6. Vignette (if specified)
    7. Monochromatic Gaussian grain
    8. Halation (if specified)

Inputs expected: sRGB, 8-bit per channel, RGB or RGBA. Outputs: same format.
"""

from __future__ import annotations
import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from PIL import Image, ImageFilter


# ============================================================
# PRIMITIVES
# ============================================================

def _luminance(arr: np.ndarray) -> np.ndarray:
    """Compute per-pixel luminance, normalized 0-1. arr shape (H, W, 3) uint8."""
    return (0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]) / 255.0


def three_way_grade(
    arr: np.ndarray,
    shadow: tuple[float, float, float],
    mid: tuple[float, float, float],
    high: tuple[float, float, float],
    intensity: float = 1.0,
) -> np.ndarray:
    """Adds shadow/mid/high color offsets weighted by per-pixel luminance position."""
    L = _luminance(arr)
    shadow_w = np.maximum(0, 1 - 2 * L)
    high_w = np.maximum(0, 2 * (L - 0.5))
    mid_w = 1 - shadow_w - high_w

    out = arr.astype(np.float32)
    for ch in range(3):
        offset = (shadow[ch] * shadow_w + mid[ch] * mid_w + high[ch] * high_w) * intensity
        out[..., ch] = out[..., ch] + offset
    return np.clip(out, 0, 255).astype(np.uint8)


def adjust_hue_saturation(
    arr: np.ndarray,
    target_hue: float,
    hue_range: float,
    sat_mult: float,
) -> np.ndarray:
    """
    For pixels whose hue is within target_hue ± hue_range degrees, multiply saturation by sat_mult.
    Pixels outside the range are unchanged.
    """
    out = arr.astype(np.float32)
    r, g, b = out[..., 0] / 255, out[..., 1] / 255, out[..., 2] / 255
    maxc = np.max(out[..., :3], axis=-1) / 255
    minc = np.min(out[..., :3], axis=-1) / 255
    delta = maxc - minc

    # Compute hue (only where delta > 0)
    hue = np.zeros_like(maxc)
    mask = delta > 0.01
    
    # Compute hue per region (where r/g/b is max)
    rmax = (maxc == r) & mask
    gmax = (maxc == g) & mask
    bmax = (maxc == b) & mask

    safe_delta = np.where(delta > 0, delta, 1)  # avoid div-by-zero
    hue[rmax] = ((g[rmax] - b[rmax]) / safe_delta[rmax]) % 6
    hue[gmax] = ((b[gmax] - r[gmax]) / safe_delta[gmax]) + 2
    hue[bmax] = ((r[bmax] - g[bmax]) / safe_delta[bmax]) + 4
    hue = hue * 60  # 0-360

    # Distance from target hue, accounting for wrap
    hue_dist = np.abs(hue - target_hue)
    hue_dist = np.minimum(hue_dist, 360 - hue_dist)

    # Weight: 1 at target, 0 at edge of range
    in_range = hue_dist < hue_range
    weight = np.where(in_range, 1 - (hue_dist / hue_range), 0)

    # Apply saturation adjustment
    L = (0.299 * out[..., 0] + 0.587 * out[..., 1] + 0.114 * out[..., 2])
    mult = 1 + (sat_mult - 1) * weight
    for ch in range(3):
        out[..., ch] = L + (out[..., ch] - L) * mult

    if arr.shape[-1] == 4:
        out[..., 3] = arr[..., 3]
    return np.clip(out, 0, 255).astype(np.uint8)


def lift_blacks(arr: np.ndarray, amount: float) -> np.ndarray:
    """Raises the black floor. amount typically 0.15-0.45."""
    out = arr.astype(np.float32)
    out[..., :3] = out[..., :3] * (1 - amount * 0.4) + amount * 30
    return np.clip(out, 0, 255).astype(np.uint8)


def crush_blacks(arr: np.ndarray, threshold: int = 70, amount: int = 8) -> np.ndarray:
    """Pushes dark pixels darker. threshold 60-80, amount 6-10 typical."""
    out = arr.astype(np.float32)
    mask = out[..., :3] < threshold
    out[..., :3] = np.where(mask, out[..., :3] - amount, out[..., :3])
    return np.clip(out, 0, 255).astype(np.uint8)


def roll_highlights(arr: np.ndarray, threshold: int = 215, amount: float = 0.2) -> np.ndarray:
    """Soft compression of values above threshold. amount 0.15-0.35 typical."""
    out = arr.astype(np.float32)
    over = out[..., :3] - threshold
    mask = out[..., :3] > threshold
    compressed = threshold + over * (1 - amount)
    out[..., :3] = np.where(mask, compressed, out[..., :3])
    return np.clip(out, 0, 255).astype(np.uint8)


def s_curve_contrast(arr: np.ndarray, amount: float = 0.15) -> np.ndarray:
    """Symmetric S-curve. amount -0.1 to +0.25 typical."""
    out = arr.astype(np.float32) / 255
    rgb = out[..., :3]
    
    below = rgb < 0.5
    rgb_new = np.where(
        below,
        0.5 * np.power(np.maximum(2 * rgb, 1e-9), 1 + amount),
        1 - 0.5 * np.power(np.maximum(2 * (1 - rgb), 1e-9), 1 + amount),
    )
    out[..., :3] = rgb_new
    return np.clip(out * 255, 0, 255).astype(np.uint8)


def vignette(arr: np.ndarray, strength: float = 0.3) -> np.ndarray:
    """Darken corners. strength 0.2-0.5 typical."""
    h, w = arr.shape[:2]
    cy, cx = h / 2, w / 2
    y, x = np.ogrid[:h, :w]
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    max_d = math.sqrt(cx ** 2 + cy ** 2)
    norm_d = d / max_d
    falloff = 1 - np.power(norm_d, 2.2) * strength

    out = arr.astype(np.float32)
    out[..., :3] = out[..., :3] * falloff[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)


def mono_grain(arr: np.ndarray, intensity: float = 13, seed: Optional[int] = None) -> np.ndarray:
    """
    Monochromatic Gaussian luminance grain, midtone-weighted.
    Same noise value added to R, G, B (no chromatic noise).
    """
    rng = np.random.default_rng(seed)
    h, w = arr.shape[:2]
    
    L = _luminance(arr)
    midtone_mask = np.maximum(0.2, 1 - np.abs(L - 0.5) * 1.6)
    noise = rng.standard_normal((h, w)) * intensity * midtone_mask

    out = arr.astype(np.float32)
    for ch in range(3):
        out[..., ch] = out[..., ch] + noise
    return np.clip(out, 0, 255).astype(np.uint8)


def halation(arr: np.ndarray, strength: float = 0.5, color: tuple[int, int, int] = (255, 90, 40)) -> np.ndarray:
    """
    Cinestill-style red/orange glow around bright highlights.
    Heavier computation: extracts highlights, blurs, screen-composites.
    """
    h, w = arr.shape[:2]
    L = _luminance(arr) * 255
    mask = np.maximum(0, (L - 140) / 115)

    # Build colored highlight layer
    highlight = np.zeros((h, w, 4), dtype=np.float32)
    highlight[..., 0] = color[0] * mask
    highlight[..., 1] = color[1] * mask
    highlight[..., 2] = color[2] * mask
    highlight[..., 3] = 255 * mask * strength

    # Blur it
    highlight_img = Image.fromarray(np.clip(highlight, 0, 255).astype(np.uint8), 'RGBA')
    blur_radius = max(2, w // 80)
    highlight_img = highlight_img.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    highlight_arr = np.array(highlight_img).astype(np.float32)

    # Screen blend: 1 - (1-a)(1-b)
    base = arr[..., :3].astype(np.float32) / 255
    overlay = highlight_arr[..., :3] / 255
    alpha = (highlight_arr[..., 3] / 255)[..., None]

    blended = 1 - (1 - base) * (1 - overlay)
    out = arr.astype(np.float32)
    out[..., :3] = (base * (1 - alpha) + blended * alpha) * 255
    return np.clip(out, 0, 255).astype(np.uint8)


# ============================================================
# GRADE COMPOSITION
# ============================================================

@dataclass
class GradeRecipe:
    """A composable brand grade recipe. Order of fields here mirrors application order."""
    name: str
    intensity: float = 1.0
    
    # Black-point adjustment (choose at most one)
    lift_blacks_amount: Optional[float] = None
    crush_blacks_threshold: Optional[int] = None
    crush_blacks_amount: Optional[int] = None
    
    # Three-way grade (added per channel)
    shadow_rgb: tuple[float, float, float] = (0, 0, 0)
    mid_rgb: tuple[float, float, float] = (0, 0, 0)
    high_rgb: tuple[float, float, float] = (0, 0, 0)
    
    # Selective hue saturation - list of (target_hue, range, sat_mult) tuples
    hue_adjustments: list[tuple[float, float, float]] = field(default_factory=list)
    
    # Contrast
    contrast_amount: float = 0.0
    
    # Highlight rolloff
    roll_highlights_threshold: Optional[int] = None
    roll_highlights_amount: Optional[float] = None
    
    # Vignette
    vignette_strength: Optional[float] = None
    
    # Grain
    grain_intensity: float = 0.0
    grain_seed: Optional[int] = None
    
    # Halation (after grain)
    halation_strength: Optional[float] = None
    halation_color: tuple[int, int, int] = (255, 90, 40)


def apply_recipe(image: Image.Image, recipe: GradeRecipe) -> Image.Image:
    """Apply a GradeRecipe to a PIL Image. Returns a new PIL Image."""
    if image.mode not in ('RGB', 'RGBA'):
        image = image.convert('RGB')
    
    arr = np.array(image)
    has_alpha = arr.shape[-1] == 4
    
    # 1. Black point
    if recipe.lift_blacks_amount is not None:
        arr = lift_blacks(arr, recipe.lift_blacks_amount * recipe.intensity)
    elif recipe.crush_blacks_threshold is not None and recipe.crush_blacks_amount is not None:
        arr = crush_blacks(
            arr,
            threshold=recipe.crush_blacks_threshold,
            amount=int(recipe.crush_blacks_amount * recipe.intensity),
        )
    
    # 2. Three-way grade
    if any(any(c != 0 for c in t) for t in [recipe.shadow_rgb, recipe.mid_rgb, recipe.high_rgb]):
        arr = three_way_grade(arr, recipe.shadow_rgb, recipe.mid_rgb, recipe.high_rgb, recipe.intensity)
    
    # 3. Hue saturation
    for target, hrange, mult in recipe.hue_adjustments:
        arr = adjust_hue_saturation(arr, target, hrange, mult)
    
    # 4. Contrast
    if recipe.contrast_amount != 0:
        arr = s_curve_contrast(arr, recipe.contrast_amount * recipe.intensity)
    
    # 5. Roll highlights
    if recipe.roll_highlights_threshold is not None and recipe.roll_highlights_amount is not None:
        arr = roll_highlights(
            arr,
            threshold=recipe.roll_highlights_threshold,
            amount=recipe.roll_highlights_amount * recipe.intensity,
        )
    
    # 6. Vignette
    if recipe.vignette_strength is not None:
        arr = vignette(arr, recipe.vignette_strength * recipe.intensity)
    
    # 7. Grain (always last unless halation follows)
    if recipe.grain_intensity > 0:
        arr = mono_grain(arr, intensity=recipe.grain_intensity, seed=recipe.grain_seed)
    
    # 8. Halation (after grain)
    if recipe.halation_strength is not None:
        arr = halation(arr, strength=recipe.halation_strength, color=recipe.halation_color)
    
    return Image.fromarray(arr)
