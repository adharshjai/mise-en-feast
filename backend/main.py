"""
Pantry AI backend — receipt OCR + recipe generation via Gemini, and (skeleton,
see identify.py) a photo of a dish → its recipe.

Receipt scanning (/scan) can also run on an NVIDIA vision model through NVIDIA's
OpenAI-compatible API: set LLM_PROVIDER=nvidia (see "Providers" in README.md).

Pairs with the static frontend in ../frontend (Supabase for auth/persistence).

Run from this folder:
    copy .env.example .env   # then paste GEMINI_API_KEY
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import traceback
from datetime import date, timedelta
from typing import Literal

import openai
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

import identify as ident
import recipes as rx

load_dotenv()  # must run before the client is built

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

_client = None


def gemini():
    """The Gemini client, built on first use so a missing key is a clear 503, not a crash at import."""
    global _client
    if _client is None:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise HTTPException(503, "GEMINI_API_KEY is not set. Add it to backend/.env (local) or the Vercel project's environment variables.")
        _client = genai.Client(api_key=api_key)
    return _client


# ---------------------------------------------------------------------------
# Receipt provider: Gemini (default) or NVIDIA through its OpenAI-compatible API
# ---------------------------------------------------------------------------
# Only /scan looks at LLM_PROVIDER; /recipes and /identify always use Gemini.
# Everything here is read at call time, like gemini(), so editing .env and
# restarting (or prefixing the uvicorn line with the variables) is enough.

NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1"
NVIDIA_DEFAULT_VISION_MODEL = "nvidia/nemotron-nano-12b-v2-vl"
# Above this size the photo is downscaled to 2048 px and re-encoded as JPEG
# before it goes into the request as a data URL (see _image_data_url).
NVIDIA_MAX_IMAGE_BYTES = 4 * 1024 * 1024
# Models that answered 400 to response_format and then succeeded without it.
# JSON mode is skipped for them from then on so every scan does not first pay
# for a rejected image upload (NVIDIA lists structured output as unsupported
# for the Nemotron VL model).
_JSON_MODE_UNSUPPORTED: set[str] = set()


def llm_provider() -> str:
    """'nvidia' or 'gemini'. Unset and anything unrecognised mean Gemini."""
    return "nvidia" if os.getenv("LLM_PROVIDER", "gemini").strip().lower() == "nvidia" else "gemini"


def nvidia_base_url() -> str:
    return os.getenv("NVIDIA_BASE_URL", "").strip() or NVIDIA_DEFAULT_BASE_URL


def nvidia_vision_model() -> str:
    return os.getenv("NVIDIA_VISION_MODEL", "").strip() or NVIDIA_DEFAULT_VISION_MODEL


_nvidia_client = None


def nvidia():
    """The NVIDIA client (the OpenAI SDK pointed at NVIDIA's endpoint), built on first use like gemini()."""
    global _nvidia_client
    if _nvidia_client is None:
        api_key = os.getenv("NVIDIA_API_KEY")
        if not api_key:
            raise HTTPException(
                503,
                "LLM_PROVIDER is 'nvidia' but NVIDIA_API_KEY is not set. Add it to backend/.env (local) "
                "or the Vercel project's environment variables, or unset LLM_PROVIDER to scan with Gemini.",
            )
        _nvidia_client = openai.OpenAI(base_url=nvidia_base_url(), api_key=api_key)
    return _nvidia_client


app = FastAPI(title="Pantry AI")

# Frontend is served separately (e.g. localhost:4173); allow local + common hosts.
_origins = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:4173,http://127.0.0.1:4173,http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?$|https://[a-z0-9.-]+\.vercel\.app$",
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# What we ask Gemini for
# ---------------------------------------------------------------------------
# Note: we ask for DAYS, never dates. The model has no reliable idea what
# today is and is bad at calendar math. It knows "spinach lasts about a week."
# We turn days into dates ourselves, below.


class ReceiptItem(BaseModel):
    raw_text: str = Field(description="The line exactly as printed on the receipt.")
    name: str = Field(description="Clean display name. 'GV MLK 1GAL' -> 'Milk, 1 gal'.")
    is_food: bool = Field(description="False for paper towels, batteries, bags, etc.")
    category: str = Field(description="produce, dairy, meat, pantry, frozen, bakery, other")

    quantity: float = Field(description="Count or weight from the receipt. 1 if absent.")
    unit: str = Field(description="lb, oz, gal, count, bunch, etc. Empty string if unclear.")
    price: float = Field(description="Line total in dollars.")

    servings: float = Field(
        description=(
            "Estimated servings in this package. A gallon of milk is about 16. "
            "A 2 lb bag of rice is about 20. This is the unit the pantry runs on."
        )
    )
    shelf_life_days: int = Field(
        description=(
            "Days from purchase until this typically spoils, stored normally. "
            "Spinach 7, eggs 30, dried rice 730."
        )
    )
    days_to_use_up: int = Field(
        description=(
            "Days until an average household finishes this, assuming normal use. "
            "For most produce this is shorter than shelf life. For staples it is longer."
        )
    )
    burn_pattern: Literal["continuous", "event"] = Field(
        description=(
            "'continuous' for things consumed steadily, like milk or bananas. "
            "'event' for things only used when a recipe calls for them, like curry paste."
        )
    )
    group_key: str = Field(
        description=(
            "Canonical food identity for stacking similar purchases across brands and trips. "
            "Lowercase, brand-agnostic. Examples: 'bananas', 'whole milk', 'italian sausage', "
            "'eggs', 'spinach'. Chiquita bananas and store-brand bananas both get 'bananas'. "
            "Two sausage brands of the same type share one group_key."
        )
    )
    variant: str = Field(
        description=(
            "Brand or pack detail that distinguishes this lot, or empty string. "
            "Examples: 'Chiquita', 'Johnsonville mild', 'organic'."
        )
    )


class ParsedReceipt(BaseModel):
    store_name: str
    purchase_date: str = Field(description="YYYY-MM-DD from the receipt, or empty string.")
    total: float
    items: list[ReceiptItem]


PROMPT = """You are reading a photo of a grocery receipt.

Extract every line item. For each one:
- Expand the store's shorthand into a readable name.
- Mark non-food items (cleaning supplies, bags, batteries) as is_food: false, but
  still include them so nothing looks silently dropped.
- Estimate servings, shelf life, and typical time to use up based on what an
  average household does with that item and that package size.
- Set group_key to the brand-agnostic food identity so later purchases of the same
  food (different brand, size, or trip) can stack together. Examples: all bananas
  → "bananas"; "JOHNSONVILLE MILD ITAL" and "HEBREW NATIONAL" → both "sausages"
  only if they are the same kind of product, otherwise keep distinct keys like
  "italian sausage" vs "hot dogs".
- Set variant to the brand or distinguishing detail, or "" if none.

If a line is unreadable, still include it with raw_text filled in, name set to
your best guess, and quantity 1.

Prices are line totals, not unit prices. Do not invent items that are not on
the receipt.
"""


# Gemini gets the ParsedReceipt schema (with every Field description) through
# response_schema. NVIDIA's chat API has nothing like that, so the same schema
# is rendered into the prompt as a field list, straight from the pydantic model
# so the two can never drift apart.


def _schema_type(prop: dict) -> str:
    """One JSON-schema property as a readable type: 'array of ReceiptItem objects', 'string, one of ...'."""
    if "$ref" in prop:
        return prop["$ref"].rsplit("/", 1)[-1] + " object"
    if "enum" in prop:
        return "string, one of " + ", ".join(json.dumps(v) for v in prop["enum"])
    kind = prop.get("type")
    if kind == "array":
        return "array of " + _schema_type(prop.get("items", {})) + "s"
    return kind or "value"


def _schema_fields(schema: dict) -> list[str]:
    lines = []
    for name, prop in schema.get("properties", {}).items():
        line = f'- "{name}" ({_schema_type(prop)})'
        if prop.get("description"):
            line += ": " + prop["description"]
        lines.append(line)
    return lines


def receipt_json_instructions() -> str:
    """Appended to PROMPT for providers without structured output: answer with one
    JSON object, and here is its shape, $defs flattened into plain field lists."""
    schema = ParsedReceipt.model_json_schema()
    parts = [
        "",
        "Answer with a single JSON object and nothing else: no markdown, no code fence, "
        "no commentary before or after it. Every field below is required. Numbers are JSON "
        'numbers, not strings; an unknown string is "".',
        "",
        "The object has these fields:",
        *_schema_fields(schema),
    ]
    for name, definition in schema.get("$defs", {}).items():
        parts += ["", f"Each {name} object has these fields:", *_schema_fields(definition)]
    return "\n".join(parts) + "\n"


JSON_INSTRUCTIONS = receipt_json_instructions()


# ---------------------------------------------------------------------------
# Enrichment: days -> dates, done in Python
# ---------------------------------------------------------------------------


def to_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value.strip())
    except (ValueError, AttributeError):
        return None


CHARGE_WORDS = (
    "fee", "deposit", "tax", "gst", "hst", "pst", "vat", "bag charge",
    "subtotal", "total", "change", "tender", "rounding", "discount", "coupon",
)


def is_charge(item: ReceiptItem) -> bool:
    """Fees and taxes parse as items and then sort to the top as 'expiring today'."""
    name = item.name.lower()
    if any(word in name for word in CHARGE_WORDS):
        return True
    # Zero servings means there is nothing to consume, so it is not pantry stock.
    return item.servings <= 0


def enrich(parsed: ParsedReceipt) -> dict:
    purchased = to_date(parsed.purchase_date) or date.today()

    items = []
    for item in parsed.items:
        if is_charge(item):
            continue  # fees and deposits are not things you own

        shelf = max(item.shelf_life_days, 1)
        use_up = max(item.days_to_use_up, 1)

        expiration = purchased + timedelta(days=shelf)
        use_by = purchased + timedelta(days=use_up)

        # Whichever comes first is what the UI should actually warn about.
        deadline = min(expiration, use_by)
        reason = "spoils" if expiration <= use_by else "runs out"

        group = re.sub(r"[^a-z0-9]+", " ", (item.group_key or item.name).lower()).strip()
        group = re.sub(r"\s+", " ", group) or re.sub(r"[^a-z0-9]+", "-", item.name.lower()).strip("-")

        items.append(
            {
                **item.model_dump(),
                "id": re.sub(r"[^a-z0-9]+", "-", item.name.lower()).strip("-"),
                "group_key": group,
                "variant": (item.variant or "").strip(),
                "purchase_date": purchased.isoformat(),
                "expiration_date": expiration.isoformat(),
                "projected_use_up_date": use_by.isoformat(),
                "deadline_date": deadline.isoformat(),
                "deadline_reason": reason,
                "days_left": (deadline - date.today()).days,
                "daily_burn_rate": round(item.servings / use_up, 3),
                "initial_servings": item.servings,
                "quantity_servings": item.servings,
                "status": "active",
            }
        )

    items.sort(key=lambda i: i["days_left"])

    return {
        "store_name": parsed.store_name,
        "purchase_date": purchased.isoformat(),
        "total": parsed.total,
        "item_count": len(items),
        "food_count": sum(1 for i in items if i["is_food"]),
        "items": items,
    }


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


def call_gemini(image_bytes: bytes, mime_type: str) -> ParsedReceipt:
    response = gemini().models.generate_content(
        model=MODEL,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            PROMPT,
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ParsedReceipt,
            # No temperature / top_p / top_k. Gemini 3.x is tuned for defaults
            # and overriding them makes structured output worse, not better.
        ),
    )

    if response.parsed is not None:
        return response.parsed

    # Fallback if the SDK could not hydrate the model for some reason.
    return ParsedReceipt(**json.loads(response.text))


def _image_data_url(image_bytes: bytes, mime_type: str) -> str:
    """The upload as a base64 data URL for the chat message.

    Photos over NVIDIA_MAX_IMAGE_BYTES are downscaled to 2048 px on the long side
    (the model tiles at most 2048x1536 anyway) and re-encoded as JPEG q85 first.
    """
    if len(image_bytes) > NVIDIA_MAX_IMAGE_BYTES and mime_type.startswith("image/"):
        try:
            from PIL import Image, ImageOps

            with Image.open(io.BytesIO(image_bytes)) as src:
                img = ImageOps.exif_transpose(src)  # bake in phone orientation; the re-encode drops EXIF
                img.thumbnail((2048, 2048))  # keeps aspect, never enlarges
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                out = io.BytesIO()
                img.save(out, format="JPEG", quality=85, optimize=True)
            image_bytes, mime_type = out.getvalue(), "image/jpeg"
        except Exception:  # noqa: BLE001 — Pillow can't decode it (HEIC etc); send as is and let the API answer
            pass
    return f"data:{mime_type};base64,{base64.b64encode(image_bytes).decode('ascii')}"


def parse_receipt_json(text: str) -> ParsedReceipt:
    """Model text -> ParsedReceipt, tolerating a code fence or chatter around the object."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("the model returned an empty response")
    fenced = re.match(r"^\s*```(?:json)?\s*\n?(.*?)\n?\s*```\s*$", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError(f"no JSON object in the model response: {text.strip()[:120]!r}")
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError(f"the model returned malformed JSON ({exc.msg} at char {exc.pos}): {text.strip()[:120]!r}") from exc
    return ParsedReceipt.model_validate(data)


def call_nvidia_vision(image_bytes: bytes, mime_type: str) -> ParsedReceipt:
    """call_gemini's job through NVIDIA's OpenAI-compatible chat API.

    One non-streaming chat.completions call: Gemini's PROMPT plus the schema as
    text (JSON_INSTRUCTIONS), and the image as a data URL. JSON mode is asked
    for; a model that rejects it gets one retry without (and is remembered, so
    later scans skip JSON mode), and the answer is parsed leniently either way.
    Errors surface like Gemini's: 503 no key (nvidia()), anything else becomes
    /scan's 502.
    """
    client = nvidia()  # 503 before any image work if the key is missing

    if not mime_type.startswith("image/"):
        raise HTTPException(400, "The NVIDIA provider reads images only (png, jpg, webp). PDFs need LLM_PROVIDER=gemini.")

    model = nvidia_vision_model()
    request = dict(
        model=model,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT + JSON_INSTRUCTIONS},
                    {"type": "image_url", "image_url": {"url": _image_data_url(image_bytes, mime_type)}},
                ],
            }
        ],
        temperature=0.2,
        max_tokens=4096,
        stream=False,
    )
    if model in _JSON_MODE_UNSUPPORTED:
        response = client.chat.completions.create(**request)
    else:
        try:
            response = client.chat.completions.create(**request, response_format={"type": "json_object"})
        except (openai.BadRequestError, openai.UnprocessableEntityError):
            # Not every model behind the endpoint supports JSON mode (NVIDIA answers 400, some
            # OpenAI-compatible servers 422 for an unknown parameter); the prompt already asks for JSON.
            response = client.chat.completions.create(**request)
            _JSON_MODE_UNSUPPORTED.add(model)  # the retry worked, so it really was response_format

    if not getattr(response, "choices", None):
        raise ValueError("the model returned no choices")
    return parse_receipt_json(response.choices[0].message.content)


@app.post("/scan")
async def scan_receipt(file: UploadFile = File(...)):
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(400, "Empty file.")

    mime_type = file.content_type or "image/jpeg"
    if not (mime_type.startswith("image/") or mime_type == "application/pdf"):
        raise HTTPException(400, f"Unsupported type: {mime_type}")

    parse = call_nvidia_vision if llm_provider() == "nvidia" else call_gemini

    last_error = None
    for _ in range(2):  # one retry, parsing occasionally comes back malformed
        try:
            return enrich(parse(image_bytes, mime_type))
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            last_error = exc

    raise HTTPException(502, f"Could not parse receipt: {last_error}")


@app.post("/recipes")
def get_recipes(req: rx.RecipeRequest):
    """Generate dishes from pantry contents. Send the items array from /scan.

    Optional `prefs` (preferences contract v2, see recipes.py) shapes the prompt
    (allergies and diet as hard rules; cuisines, time, skill, equipment,
    dislikes and household size as preferences) and is enforced again in
    rank(), which drops any dish that trips one of the household's allergies.
    """
    try:
        generated = rx.generate(req, gemini(), MODEL)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()  # the terminal is where you'll actually read this
        raise HTTPException(502, f"Recipe generation failed: {exc}") from exc

    ranked = rx.rank(generated, req.max_missing, req.items, prefs=req.prefs)
    return {
        "count": len(ranked),
        "recipes": ranked,
    }


class CookRequest(BaseModel):
    items: list[rx.PantryItem]
    deductions: dict[str, float]  # pantry item id or name -> servings used


@app.post("/cook")
def cook(req: CookRequest):
    """Subtract a cooked recipe from the pantry. Powers the Made It button."""
    updated, depleted = [], []

    for item in req.items:
        key = item.id or item.name
        used = req.deductions.get(key, req.deductions.get(item.name, 0))
        remaining = round(max(item.quantity_servings - used, 0), 2)

        row = item.model_dump()
        row["quantity_servings"] = remaining
        if used and remaining <= 0:
            row["status"] = "needs_checkin"
            depleted.append(item.name)
        updated.append(row)

    return {"items": updated, "depleted": depleted}


@app.post("/identify")
async def identify_dish(file: UploadFile = File(...)):
    """Photo of a dish → its recipe (contract in identify.py). SKELETON:

    - IDENTIFY_STUB=1  → the canned shakshuka in identify.SAMPLE_IDENTIFIED, no key needed.
    - otherwise        → 501 "identify is not implemented yet" until the owner pastes
                         the Gemini call into identify.identify() (five commented lines).
    Once wired up, errors map like /scan and /recipes: 400 bad upload, 503 no key,
    502 the model call failed.
    """
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(400, "Empty file.")

    mime_type = file.content_type or "image/jpeg"
    if not mime_type.startswith("image/"):
        raise HTTPException(400, f"Unsupported type: {mime_type}")

    try:
        # Only build the client when it will be used, so the stub works without a key.
        client = None if ident.stubbed() else gemini()
        dish = ident.identify(image_bytes, mime_type, client, MODEL)
    except HTTPException:
        raise
    except NotImplementedError:
        raise HTTPException(501, "identify is not implemented yet")
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()  # the terminal is where you'll actually read this
        raise HTTPException(502, f"Could not identify dish: {exc}") from exc

    return dish.model_dump()


@app.get("/health")
def health():
    """Which provider /scan will use and whether its key is present (never the key itself).
    `model` and `key_set` stay Gemini's: /recipes and /identify use it whatever the provider."""
    provider = llm_provider()
    out = {"ok": True, "provider": provider, "model": MODEL, "key_set": bool(os.getenv("GEMINI_API_KEY"))}
    if provider == "nvidia":
        out["vision_model"] = nvidia_vision_model()
        out["nvidia_base_url"] = nvidia_base_url()
        out["nvidia_key_set"] = bool(os.getenv("NVIDIA_API_KEY"))
    return out


@app.get("/")
def root():
    return {
        "ok": True,
        "service": "pantry-ai",
        "health": "/health",
        "docs": "/docs",
        "endpoints": ["/scan", "/recipes", "/cook", "/identify"],
    }