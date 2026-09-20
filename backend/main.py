"""
Pantry AI backend — receipt OCR, recipe generation, and a photo of a dish → its
recipe, all via Gemini (see recipes.py and identify.py).

Pairs with the static frontend in ../frontend (Supabase for auth/persistence).

Run from this folder:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000   # with GEMINI_API_KEY in .env
"""

from __future__ import annotations

import os
import re
import traceback
from datetime import date, timedelta
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

import identify as ident
import llm
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
            "Days until a TWO-PERSON household finishes this, assuming normal use. "
            "Always answer for two people; the app scales this to the real household "
            "size itself. For most produce this is shorter than shelf life. For "
            "staples it is longer."
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
- Estimate servings, shelf life, and typical time to use up based on what a
  two-person household does with that item and that package size. Always answer
  for two people, whatever the package size suggests; the app scales the result
  to the real household itself.
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
    return llm.generate_json(
        gemini(),
        [types.Part.from_bytes(data=image_bytes, mime_type=mime_type), PROMPT],
        ParsedReceipt,
        MODEL,
    )


@app.post("/scan")
async def scan_receipt(file: UploadFile = File(...)):
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(400, "Empty file.")

    mime_type = file.content_type or "image/jpeg"
    if not (mime_type.startswith("image/") or mime_type == "application/pdf"):
        raise HTTPException(400, f"Unsupported type: {mime_type}")

    last_error = None
    for _ in range(2):  # one retry, parsing occasionally comes back malformed
        try:
            return enrich(call_gemini(image_bytes, mime_type))
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
    """Photo of a dish → its recipe (contract in identify.py).

    IDENTIFY_STUB=1 answers with the canned shakshuka in identify.SAMPLE_IDENTIFIED
    and never calls Gemini, so the flow works without a key. Errors map like /scan
    and /recipes: 400 bad upload, 503 no key, 502 the model call failed.
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
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()  # the terminal is where you'll actually read this
        raise HTTPException(502, f"Could not identify dish: {exc}") from exc

    return dish.model_dump()


@app.get("/health")
def health():
    """The model everything runs on, and whether the key is present (never the key itself)."""
    return {"ok": True, "model": MODEL, "key_set": bool(os.getenv("GEMINI_API_KEY"))}


@app.get("/")
def root():
    return {
        "ok": True,
        "service": "pantry-ai",
        "health": "/health",
        "docs": "/docs",
        "endpoints": ["/scan", "/recipes", "/cook", "/identify"],
    }