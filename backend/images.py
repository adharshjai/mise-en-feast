"""
Dish photos for the cards: one Gemini image call per dish, cached.

    GET /dish-image?title=Spinach+and+garlic+pasta&ingredients=spinach,garlic,pasta&seed=0
    -> image/jpeg bytes, Cache-Control: public, max-age=31536000, immutable, X-Dish-Slug

The browser caches by URL for a year, so the client's slug (frontend/shared/
dish-images.js) is what decides when a dish gets a new picture; this side just
has to answer the same URL with the same picture for as long as the process
lives, which is what the small LRU below is for.

Model: GEMINI_IMAGE_MODEL when set, otherwise the first of IMAGE_MODELS that
answers. An unknown model (404, or a 400 that names the model) moves to the
next candidate and the winner is remembered for the process; any other error
(quota, auth, safety) is raised as-is so the route can report it.

Pillow, when importable, downscales the picture to MAX_SIDE and re-encodes it as
JPEG; without it the model's bytes go out untouched with their own mime type.
"""

from __future__ import annotations

import os
import re
from collections import OrderedDict
from io import BytesIO
from typing import NamedTuple

from google.genai import errors, types

IMAGE_MODELS = ("gemini-3.5-flash-image", "gemini-3-flash-image", "gemini-2.5-flash-image")
MAX_SIDE = 1024
JPEG_QUALITY = 82
CACHE_SIZE = 64


class DishImage(NamedTuple):
    data: bytes
    mime_type: str


_model: str | None = None  # the first candidate that answered, remembered for the process
_cache: OrderedDict[str, DishImage] = OrderedDict()  # slug (+seed) -> image, LRU


def slug(title: str) -> str:
    """Mirror of dishSlug in frontend/shared/dish-images.js, so both sides key the same way."""
    s = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:80].strip("-")
    return s or "dish"


def current_model() -> str | None:
    """The image model in use: the pinned one, or the candidate that last answered."""
    return os.getenv("GEMINI_IMAGE_MODEL", "").strip() or _model


def build_prompt(title: str, ingredients: list[str]) -> str:
    prompt = (
        f"Overhead food photograph of {title}, plated on a simple ceramic plate on a wooden "
        "table, natural daylight, shallow depth of field, appetizing, realistic, no text, "
        "no people, no hands."
    )
    if ingredients:
        prompt += f" Visible ingredients: {', '.join(ingredients)}."
    return prompt


def _candidates() -> list[str]:
    pinned = os.getenv("GEMINI_IMAGE_MODEL", "").strip()
    if pinned:
        return [pinned]
    if _model in IMAGE_MODELS:
        # Start from the one that worked, but keep the later ones as fallbacks in
        # case it has since been retired.
        return list(IMAGE_MODELS[IMAGE_MODELS.index(_model) :])
    return list(IMAGE_MODELS)


def _invalid_model(exc: Exception) -> bool:
    """A 404 (no such model), or a 400 that is about the model rather than the request."""
    code = getattr(exc, "code", None)
    if code == 404:
        return True
    text = str(getattr(exc, "message", "") or exc).lower()
    return code == 400 and "model" in text and any(w in text for w in ("not found", "not supported", "unsupported", "invalid"))


def _call(client, model: str, prompt: str, seed: int) -> DishImage:
    """One generate_content call; the first inline image part is the answer."""
    config = types.GenerateContentConfig(response_modalities=["IMAGE"], seed=seed or None)
    try:
        response = client.models.generate_content(model=model, contents=prompt, config=config)
    except errors.APIError as exc:
        # Not every image model takes a seed. Rather than lose the picture over a
        # variation hint, retry once without it.
        if seed and exc.code == 400 and "seed" in str(getattr(exc, "message", "") or exc).lower():
            config = types.GenerateContentConfig(response_modalities=["IMAGE"])
            response = client.models.generate_content(model=model, contents=prompt, config=config)
        else:
            raise
    for candidate in response.candidates or []:
        parts = (candidate.content.parts if candidate.content else None) or []
        for part in parts:
            blob = getattr(part, "inline_data", None)
            if blob is not None and blob.data:
                return DishImage(bytes(blob.data), blob.mime_type or "image/png")
    raise ValueError("the model returned no image")


def _generate(client, prompt: str, seed: int) -> DishImage:
    global _model
    last: Exception | None = None
    for model in _candidates():
        try:
            image = _call(client, model, prompt, seed)
        except errors.APIError as exc:
            if not _invalid_model(exc):
                raise
            last = exc  # unknown model: try the next candidate
            continue
        _model = model
        return image
    raise last or ValueError("no image model is available")


def _shrink(image: DishImage) -> DishImage:
    """Downscale to MAX_SIDE on the long side and re-encode as JPEG. Without Pillow, or
    for bytes Pillow cannot read, the original goes out as-is: a big picture still
    beats a 502."""
    try:
        from PIL import Image
    except ImportError:
        return image
    try:
        with Image.open(BytesIO(image.data)) as im:
            rgb = im.convert("RGB")
            rgb.thumbnail((MAX_SIDE, MAX_SIDE))
            out = BytesIO()
            rgb.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return DishImage(out.getvalue(), "image/jpeg")
    except Exception:  # noqa: BLE001
        return image


def generate_dish_image(client, title: str, ingredients: list[str] | None = None, seed: int = 0) -> DishImage:
    """The picture for a dish, from the LRU when we have drawn it before.

    `client` is the Gemini client (main.gemini()); `ingredients` are the names to
    show on the plate; `seed` (0 = none) asks for a different take on the same
    title and gets its own cache slot.
    """
    key = slug(title) if not seed else f"{slug(title)}#{seed}"
    hit = _cache.get(key)
    if hit is not None:
        _cache.move_to_end(key)
        return hit

    names = [n.strip() for n in (ingredients or []) if n and n.strip()]
    image = _shrink(_generate(client, build_prompt(" ".join(title.split()), names), seed))

    _cache[key] = image
    while len(_cache) > CACHE_SIZE:
        _cache.popitem(last=False)
    return image
