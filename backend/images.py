"""
Dish photos for the cards: one picture per dish, from the first source that can
draw or find one, cached.

Sources, in order (a source that fails for a reason that will not change, such
as a quota of zero or a model this account cannot use, is skipped for the rest
of the process):
  1. Gemini image generation (GEMINI_IMAGE_MODEL / IMAGE_MODELS below)
  2. Amazon Nova Canvas on Bedrock, with the same credentials the chatbot uses
     (BEDROCK_IMAGE_MODEL_ID, BEDROCK_IMAGE_REGION; Nova Canvas lives in us-east-1)
  3. A real photograph from TheMealDB, matched on the title and then on the main
     ingredient, chosen deterministically per dish so the same dish keeps its photo

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

import base64
import hashlib
import json
import os
import re
import urllib.parse
import urllib.request
from collections import OrderedDict
from io import BytesIO
from typing import NamedTuple

from google.genai import errors, types

import bedrock

IMAGE_MODELS = ("gemini-3.5-flash-image", "gemini-3-flash-image", "gemini-2.5-flash-image")
MAX_SIDE = 1024
JPEG_QUALITY = 82
CACHE_SIZE = 64


class DishImage(NamedTuple):
    data: bytes
    mime_type: str


_model: str | None = None  # the first candidate that answered, remembered for the process
_cache: OrderedDict[str, DishImage] = OrderedDict()  # slug (+seed) -> image, LRU
_dead: dict[str, str] = {}  # source -> why it is skipped for the rest of the process
_last_source: str | None = None


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


# ---------------------------------------------------------------------------
# Source 2: Amazon Nova Canvas on Bedrock
# ---------------------------------------------------------------------------

NOVA_MODEL = "amazon.nova-canvas-v1:0"
NOVA_REGION = "us-east-1"
_nova_client = None


def _nova(prompt: str, seed: int) -> DishImage:
    """One Nova Canvas text-to-image call through the Bedrock runtime. The chatbot's
    credentials are reused; only the region can differ (Nova Canvas is not in every one)."""
    global _nova_client
    if not bedrock.credentials_present():
        raise RuntimeError("Bedrock is not configured")
    if _nova_client is None:
        import boto3  # already a dependency of the chatbot

        _nova_client = boto3.client("bedrock-runtime", region_name=os.getenv("BEDROCK_IMAGE_REGION", "").strip() or NOVA_REGION)
    body = {
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {
            "text": prompt[:1000],
            "negativeText": "text, words, letters, watermark, logo, people, hands, cartoon, illustration, blurry",
        },
        "imageGenerationConfig": {
            "numberOfImages": 1,
            "quality": "standard",
            "width": 1024,
            "height": 768,
            "cfgScale": 6.5,
            "seed": int(seed) % 858993459 if seed else 0,
        },
    }
    response = _nova_client.invoke_model(
        modelId=os.getenv("BEDROCK_IMAGE_MODEL_ID", "").strip() or NOVA_MODEL,
        body=json.dumps(body),
        contentType="application/json",
        accept="application/json",
    )
    out = json.loads(response["body"].read())
    images = out.get("images") or []
    if not images:
        raise ValueError(out.get("error") or "Nova Canvas returned no image")
    return DishImage(base64.b64decode(images[0]), "image/png")


# ---------------------------------------------------------------------------
# Source 3: a real photograph from TheMealDB (no key needed)
# ---------------------------------------------------------------------------

MEALDB = "https://www.themealdb.com/api/json/v1/1"
_STOP = {"and", "with", "the", "a", "of", "in", "on", "style", "easy", "quick", "simple", "creamy", "crispy", "spicy", "fresh", "homemade"}


def _http_json(url: str, timeout: float = 5.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "mise-en-feast/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def _http_bytes(url: str, timeout: float = 8.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "mise-en-feast/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def _pick(meals: list[dict], key: str) -> dict:
    """The same dish always gets the same photo from a list: index by a hash of its slug."""
    n = int(hashlib.sha1(key.encode("utf-8")).hexdigest(), 16)
    return meals[n % len(meals)]


def _mealdb_thumb(title: str, ingredients: list[str], key: str) -> str:
    """The photo URL for a dish: the title first, then its strongest words, then the
    main ingredient's dishes. Raises when nothing matches."""
    words = [w for w in re.findall(r"[a-z]+", title.lower()) if len(w) > 2 and w not in _STOP]
    tried: list[str] = []
    for q in [title] + [w for w in reversed(words)][:3]:
        q = q.strip()
        if not q or q in tried:
            continue
        tried.append(q)
        data = _http_json(f"{MEALDB}/search.php?s={urllib.parse.quote(q)}")
        meals = data.get("meals") or []
        if meals:
            return _pick(meals, key)["strMealThumb"]
    for ing in [i for i in ingredients if i][:3]:
        base = re.findall(r"[a-z]+", ing.lower())
        if not base:
            continue
        data = _http_json(f"{MEALDB}/filter.php?i={urllib.parse.quote(base[-1])}")
        meals = data.get("meals") or []
        if meals:
            return _pick(meals, key)["strMealThumb"]
    raise LookupError("no photo matches this dish")


def _mealdb(title: str, ingredients: list[str], key: str) -> DishImage:
    url = _mealdb_thumb(title, ingredients, key)
    return DishImage(_http_bytes(url), "image/jpeg")


# ---------------------------------------------------------------------------
# The chain
# ---------------------------------------------------------------------------

_FATAL = ("quota", "resource_exhausted", "billing", "accessdenied", "access denied", "not authorized",
          "validationexception", "could not resolve", "is not configured", "not supported in this region")


def _fatal(exc: Exception) -> bool:
    """A failure that will repeat until someone changes a plan or a permission."""
    text = f"{type(exc).__name__} {exc}".lower()
    return any(w in text for w in _FATAL) or getattr(exc, "code", None) == 429


def sources_status() -> dict:
    """For /health: which picture source answered last, and which ones are skipped."""
    return {"last": _last_source, "skipped": dict(_dead)}


def _from_sources(client, title: str, names: list[str], seed: int, key: str) -> DishImage:
    global _last_source
    prompt = build_prompt(title, names)
    attempts = (
        ("gemini", lambda: _generate(client, prompt, seed)),
        ("nova", lambda: _nova(prompt, seed)),
        ("mealdb", lambda: _mealdb(title, names, key)),
    )
    errors_seen: list[str] = []
    for name, call in attempts:
        if name in _dead:
            continue
        try:
            image = call()
        except Exception as exc:  # noqa: BLE001 — every source has its own failure types
            errors_seen.append(f"{name}: {exc}")
            if _fatal(exc):
                _dead[name] = str(exc)[:200]
            continue
        _last_source = name
        return image
    raise RuntimeError("; ".join(errors_seen) or "no picture source is available")


def generate_dish_image(client, title: str, ingredients: list[str] | None = None, seed: int = 0) -> DishImage:
    """The picture for a dish, from the LRU when we have drawn it before.

    `client` is the Gemini client (main.gemini()) for the first source; `ingredients`
    are the names to show on the plate; `seed` (0 = none) asks for a different take
    on the same title and gets its own cache slot.
    """
    key = slug(title) if not seed else f"{slug(title)}#{seed}"
    hit = _cache.get(key)
    if hit is not None:
        _cache.move_to_end(key)
        return hit

    names = [n.strip() for n in (ingredients or []) if n and n.strip()]
    image = _shrink(_from_sources(client, " ".join(title.split()), names, seed, key))

    _cache[key] = image
    while len(_cache) > CACHE_SIZE:
        _cache.popitem(last=False)
    return image
