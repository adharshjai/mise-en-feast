"""
Ingredient substitutions for mise en feast — "no heavy cream?" answered from what
the household actually has.

Claude (Bedrock, the fast tier) proposes one to four swaps for a single
ingredient, given the dish, its ingredient list, the pantry and the household's
rules. Python then has the last word, the same way rank() does for recipes:
`from_pantry` is recomputed by matching the names the model claims to use
against the real pantry rows, and any swap that trips an allergy or breaks a
diet is dropped. A card can therefore never say "use the butter you have" when
there is none, and a dairy allergy is never handed a splash of cream.

Contract (frontend/shared/api.js -> fetchSubstitutions; chat.py -> suggest_substitutions):

    POST /substitutions
      { ingredient:       str,              # what they are out of, e.g. "heavy cream"
        dish_title:       str = "",         # the dish it is for, when known
        dish_ingredients: [str] = [],       # the dish's ingredient lines, "1 cup heavy cream"
        pantry:           [PantryItem] = [],   # same shape /recipes takes (pantryForApi)
        prefs:            Prefs | null }
    ->
      { substitutions: [ { use:          str,     # "milk + butter"
                           from_pantry:  bool,    # every food it needs is in the pantry
                           ratio:        str,     # "¾ cup milk + ¼ cup melted butter per 1 cup cream"
                           note:         str,     # how it changes the dish, "" when it doesn't
                           pantry_names: [str]    # exact pantry names it uses, for deduction
                         } ] }                    # pantry-based first, at most 4
    422 -> no ingredient; 503 -> Bedrock is not configured; 502 -> the model call failed

The prompt is built by build_prompt() and the post-processing by finish(), both
pure, so the whole thing can be exercised without a model call.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator

import bedrock
import recipes as rx
from recipes import PantryItem, Prefs

MAX_SUBSTITUTIONS = 4

SYSTEM = (
    "You are a practical home cook who knows ingredient substitutions cold: what each "
    "ingredient does in a dish and what else does that job. You reply with exactly the "
    "JSON object requested and nothing else."
)


def _tidy(value, limit: int) -> str:
    """One line of text as the model or client sent it: whitespace collapsed, capped."""
    return " ".join(str(value or "").split())[:limit].strip()


def _lines(value, limit: int, count: int) -> list[str]:
    """A list of short strings; a bare string is one entry, anything else is none."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    out = [_tidy(v, limit) for v in value if isinstance(v, (str, int, float))]
    return [v for v in out if v][:count]


# ---------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------


class SubRequest(BaseModel):
    ingredient: str = Field(min_length=1, max_length=120)
    dish_title: str = ""
    dish_ingredients: list[str] = Field(default_factory=list)
    pantry: list[PantryItem] = Field(default_factory=list)
    prefs: Prefs | None = None

    @field_validator("ingredient", "dish_title", mode="before")
    @classmethod
    def _text(cls, v):
        return _tidy(v, 120)

    @field_validator("dish_ingredients", mode="before")
    @classmethod
    def _ings(cls, v):
        return _lines(v, 120, 40)


class Substitution(BaseModel):
    use: str  # e.g. "milk + butter"
    from_pantry: bool = False  # recomputed in finish(); the model's value is only a hint
    ratio: str = ""  # e.g. "¾ cup milk + ¼ cup melted butter per 1 cup cream"
    note: str = ""
    pantry_names: list[str] = Field(default_factory=list)  # exact pantry names it uses

    @field_validator("use", "ratio", "note", mode="before")
    @classmethod
    def _text(cls, v):
        return _tidy(v, 200)

    @field_validator("from_pantry", mode="before")
    @classmethod
    def _flag(cls, v):
        if isinstance(v, str):
            return v.strip().lower() in ("1", "true", "yes")
        return bool(v)

    @field_validator("pantry_names", mode="before")
    @classmethod
    def _names(cls, v):
        return _lines(v, 80, 8)


class _SubBatch(BaseModel):
    substitutions: list[Substitution] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

PROMPT = """The cook is out of one ingredient and wants to know what to use instead.

MISSING INGREDIENT: {ingredient}
DISH: {dish}
DISH INGREDIENTS:
{dish_ingredients}

PANTRY (what they actually have right now):
{pantry}
{hard_rules}{preferences}
Give 1 to {max} substitutions for the missing ingredient in this dish, best first:
- Pantry first. Anything they can do with the pantry list above comes before
  anything they would have to buy. Set from_pantry = true only when EVERY food the
  swap needs is on the pantry list, and copy those pantry names EXACTLY as written
  above into pantry_names (leave it empty when from_pantry is false).
- use names the swap plainly, foods joined with " + " when it takes more than one:
  "milk + butter", "greek yogurt".
- ratio is realistic for this dish and says per what: "¾ cup milk + ¼ cup melted
  butter per 1 cup heavy cream", "1:1".
- note is one short sentence on how the swap changes the dish (texture, taste,
  what it cannot do, when to add it). "" when nothing changes.
- Never suggest anything the hard rules above forbid, and nothing they dislike.
- Salt, pepper, water, oil and sugar are always on hand.
- If nothing sensible stands in for it in this dish, an empty list is the right answer.

Answer with a single JSON object and nothing else, no markdown, no code fence:
{{"substitutions": [{{"use": "milk + butter", "from_pantry": true, "ratio": "...", "note": "...", "pantry_names": ["Milk", "Butter"]}}]}}
"""


def _food(pantry: list[PantryItem]) -> list[PantryItem]:
    return [it for it in pantry if it.is_food and it.quantity_servings > 0]


def build_prompt(req: SubRequest) -> str:
    """The prompt, pure, so it can be inspected without calling the model."""
    names = "\n".join(f"- {it.name}" for it in _food(req.pantry)) or "- (empty)"
    return PROMPT.format(
        ingredient=req.ingredient,
        dish=req.dish_title or "(not said)",
        dish_ingredients="\n".join(f"- {x}" for x in req.dish_ingredients) or "- (not given)",
        pantry=names,
        hard_rules=rx._hard_rules(req.prefs) if req.prefs else "",
        preferences=rx._preferences(req.prefs) if req.prefs else "",
        max=MAX_SUBSTITUTIONS,
    )


# ---------------------------------------------------------------------------
# The deterministic pass
# ---------------------------------------------------------------------------

# "milk + butter", "milk, butter", "milk and butter", "milk & butter" -> the foods.
# The same separators the client's localSubstitutions() splits on, so both sides
# read a swap alike.
_SPLIT = re.compile(r"\s*(?:\+|,|&|\band\b)\s*", re.IGNORECASE)


def _parts(use: str) -> list[str]:
    return [p.strip() for p in _SPLIT.split(use or "") if p.strip()]


def _from_pantry(sub: Substitution, pantry: dict[str, PantryItem]) -> None:
    """Recompute from_pantry and pantry_names against the real pantry rows.

    The names the model copied (or, when it copied none, the foods in `use`) are
    matched with the same normalisation rank() uses, and the swap is pantry-based
    only when every one of them resolves. pantry_names comes back as the exact
    pantry names, so the client can deduct them after cooking; when the swap is
    only partly covered it still lists the part that is, so the card can say
    "you have the milk, not the butter".
    """
    wanted = sub.pantry_names or _parts(sub.use)
    matched: list[str] = []
    found_all = bool(wanted) and bool(pantry)
    for name in wanted:
        item = rx._match({"name": name, "matched_name": name}, pantry) if pantry else None
        if item is None:
            found_all = False
        elif item.name not in matched:
            matched.append(item.name)
    sub.from_pantry = found_all
    sub.pantry_names = matched


def _safe(sub: Substitution, prefs: Prefs | None) -> bool:
    """False when the swap trips an allergy, breaks a diet or is something they avoid."""
    if prefs is None:
        return True
    names = [sub.use, *sub.pantry_names, *_parts(sub.use)]
    if prefs.allergies and rx.ingredient_hits(names, prefs.allergies):
        return False
    if prefs.diet and rx.diet_conflicts(names, prefs.diet):
        return False
    text = rx._norm(sub.use)
    for phrase in prefs.avoid.split(","):
        key = rx._norm(phrase)
        if key and key in text:
            return False
    return True


def finish(subs: list[Substitution], req: SubRequest) -> list[Substitution]:
    """Recompute from_pantry, drop the unsafe and the pointless, pantry-based first, cap.

    Pure, so the whole pass can be tested with a hand-written model answer."""
    pantry = {rx._norm(it.name): it for it in _food(req.pantry)}
    target = rx._norm(req.ingredient)
    out: list[Substitution] = []
    seen: set[str] = set()
    for sub in subs:
        key = rx._norm(sub.use)
        if not key or key in seen or key == target:  # empty, repeated, or "use heavy cream"
            continue
        seen.add(key)
        _from_pantry(sub, pantry)
        if not _safe(sub, req.prefs):
            continue
        out.append(sub)
    out.sort(key=lambda s: not s.from_pantry)  # stable: pantry-based first, the model's order within
    return out[:MAX_SUBSTITUTIONS]


def suggest(req: SubRequest) -> list[Substitution]:
    """Ask Claude for swaps, then run finish(). Raises HTTPException 503/502 like the
    other Bedrock paths, or ValueError when the answer was not the JSON asked for."""
    response = bedrock.converse(
        messages=[{"role": "user", "content": [{"text": build_prompt(req)}]}],
        system=SYSTEM,
        max_tokens=700,
        temperature=0.4,
        model=bedrock.model_fast(),  # a short, well-specified answer: the fast tier is enough
    )
    batch = _SubBatch.model_validate(bedrock.extract_json_object(bedrock.response_text(response)))
    return finish(batch.substitutions, req)
