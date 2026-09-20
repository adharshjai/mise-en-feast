"""Mocked tests for the NVIDIA receipt provider in main.py. No network, no key.

    .venv/bin/python dev/test_nvidia_scan.py                 # plain run, prints PASS/FAIL per test
    .venv/bin/python -m pytest dev/test_nvidia_scan.py -q    # also works under pytest, if installed

main.nvidia() is monkeypatched to hand back a fake OpenAI-style client whose
chat.completions.create records what it was asked and returns a canned,
code-fenced ParsedReceipt (14 items, two of them non-food).
"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import openai  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

try:  # the openai 3.x SDK builds its exceptions on httpx2; older ones on httpx
    import httpx2 as _httpx  # type: ignore
except ImportError:  # pragma: no cover
    import httpx as _httpx


# ---------------------------------------------------------------------------
# Canned model answer: the dev/receipt.png contents, as the model should read it
# ---------------------------------------------------------------------------


def item(raw, name, category, quantity, unit, price, servings, shelf, use_up, burn, group, variant="", food=True):
    return {
        "raw_text": raw,
        "name": name,
        "is_food": food,
        "category": category,
        "quantity": quantity,
        "unit": unit,
        "price": price,
        "servings": servings,
        "shelf_life_days": shelf,
        "days_to_use_up": use_up,
        "burn_pattern": burn,
        "group_key": group,
        "variant": variant,
    }


CANNED = {
    "store_name": "WHOLE FOODS MARKET",
    "purchase_date": "2026-09-18",
    "total": 64.18,
    "items": [
        item("ORG SPINACH 5OZ 3.49", "Organic spinach, 5 oz", "produce", 5, "oz", 3.49, 4, 7, 5, "continuous", "spinach", "organic"),
        item("GV MLK 1GAL 3.98", "Whole milk, 1 gal", "dairy", 1, "gal", 3.98, 16, 10, 8, "continuous", "whole milk"),
        item("EGGS LG DZ 4.29", "Eggs, large dozen", "dairy", 12, "count", 4.29, 12, 30, 14, "continuous", "eggs"),
        item("CHKN THIGH 1.4LB 8.12", "Chicken thighs, 1.4 lb", "meat", 1.4, "lb", 8.12, 4, 3, 3, "event", "chicken thighs"),
        item("GARLIC 0.89", "Garlic, 1 head", "produce", 1, "count", 0.89, 10, 60, 30, "event", "garlic"),
        item("SPAGHETTI 1LB 1.99", "Spaghetti, 1 lb", "pantry", 1, "lb", 1.99, 8, 730, 60, "event", "spaghetti"),
        item("ROMA TOM 6 3.24", "Roma tomatoes, 6", "produce", 6, "count", 3.24, 6, 7, 6, "continuous", "tomatoes", "roma"),
        item("BASIL BNCH 2.49", "Basil, 1 bunch", "produce", 1, "bunch", 2.49, 6, 5, 5, "event", "basil"),
        item("JASMINE RICE 2LB 4.99", "Jasmine rice, 2 lb", "pantry", 2, "lb", 4.99, 20, 730, 90, "event", "rice", "jasmine"),
        item("PARM REG 8OZ 6.99", "Parmigiano Reggiano, 8 oz", "dairy", 8, "oz", 6.99, 16, 45, 30, "event", "parmesan"),
        item("CUCUMBER 2 1.58", "Cucumbers, 2", "produce", 2, "count", 1.58, 4, 7, 6, "continuous", "cucumber"),
        item("SPRNG MX ORG 5OZ 4.49", "Organic spring mix, 5 oz", "produce", 5, "oz", 4.49, 4, 6, 4, "continuous", "salad greens", "organic"),
        item("PAPER TWL 6PK 9.99", "Paper towels, 6 pack", "other", 6, "count", 9.99, 6, 3650, 60, "continuous", "paper towels", food=False),
        item("AA BATT 8PK 7.65", "AA batteries, 8 pack", "other", 8, "count", 7.65, 8, 3650, 365, "event", "batteries", "AA", food=False),
    ],
}
assert len(CANNED["items"]) == 14 and sum(not i["is_food"] for i in CANNED["items"]) == 2

FENCED = "```json\n" + json.dumps(CANNED, indent=2) + "\n```"
PNG_BYTES = b"\x89PNG\r\n\x1a\n not really a png, the model is mocked"


# ---------------------------------------------------------------------------
# Fakes and helpers
# ---------------------------------------------------------------------------


class FakeCompletions:
    """Stands in for client.chat.completions. Records every create() call."""

    def __init__(self, content: str, reject_json_mode: bool = False, reject_all: bool = False):
        self.content = content
        self.reject_json_mode = reject_json_mode  # 400 whenever response_format is sent
        self.reject_all = reject_all  # 400 every time, whatever is sent
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.reject_all or (self.reject_json_mode and "response_format" in kwargs):
            raise openai.BadRequestError(
                "response_format is not supported by this model",
                response=_httpx.Response(400, request=_httpx.Request("POST", "https://example.invalid/v1/chat/completions")),
                body={"error": {"message": "response_format is not supported by this model"}},
            )
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=self.content))])


def fake_client(content: str = FENCED, reject_json_mode: bool = False, reject_all: bool = False):
    completions = FakeCompletions(content, reject_json_mode, reject_all)
    return SimpleNamespace(chat=SimpleNamespace(completions=completions)), completions


@contextlib.contextmanager
def env(**values):
    """Set (str) or unset (None) environment variables for the block, then restore them."""
    saved = {k: os.environ.get(k) for k in values}
    try:
        for k, v in values.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def post_scan(filename="receipt.png", data=PNG_BYTES, mime="image/png"):
    return TestClient(main.app).post("/scan", files={"file": (filename, data, mime)})


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_call_nvidia_vision_parses_fenced_json_and_sends_the_right_request():
    client, completions = fake_client()
    with (
        env(NVIDIA_VISION_MODEL=None),
        mock.patch.object(main, "nvidia", return_value=client),
        mock.patch.object(main, "_JSON_MODE_UNSUPPORTED", set()),
    ):
        parsed = main.call_nvidia_vision(PNG_BYTES, "image/png")

    assert isinstance(parsed, main.ParsedReceipt)
    assert parsed.store_name == "WHOLE FOODS MARKET" and parsed.total == 64.18
    assert len(parsed.items) == 14
    assert sum(not i.is_food for i in parsed.items) == 2

    # Exactly one non-streaming call with the specified shape.
    assert len(completions.calls) == 1
    call = completions.calls[0]
    assert call["model"] == main.NVIDIA_DEFAULT_VISION_MODEL
    assert call["temperature"] == 0.2
    assert call["max_tokens"] == 4096
    assert call["stream"] is False
    assert call["response_format"] == {"type": "json_object"}
    (message,) = call["messages"]
    assert message["role"] == "user"
    text_part, image_part = message["content"]
    assert text_part["type"] == "text"
    assert text_part["text"].startswith(main.PROMPT)
    assert text_part["text"].endswith(main.JSON_INSTRUCTIONS)
    assert "single JSON object" in text_part["text"]
    for field in ("group_key", "burn_pattern", "shelf_life_days", "purchase_date", "ReceiptItem"):
        assert field in text_part["text"], field
    assert '"continuous", "event"' in text_part["text"]  # the Literal came through as an enum
    assert image_part["type"] == "image_url"
    url = image_part["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == PNG_BYTES


def test_scan_with_nvidia_provider_returns_enriched_receipt():
    client, completions = fake_client()
    with (
        env(LLM_PROVIDER="nvidia"),
        mock.patch.object(main, "nvidia", return_value=client),
        mock.patch.object(main, "call_gemini", side_effect=AssertionError("Gemini must not be called")),
    ):
        r = post_scan()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["item_count"] == 14
    assert body["food_count"] == 12
    assert body["store_name"] == "WHOLE FOODS MARKET"
    assert body["purchase_date"] == "2026-09-18"
    assert body["total"] == 64.18
    first = body["items"][0]
    for key in ("expiration_date", "projected_use_up_date", "deadline_date", "daily_burn_rate", "group_key", "status"):
        assert key in first, key
    assert first["purchase_date"] == "2026-09-18"
    assert len(completions.calls) == 1


def test_bad_request_on_response_format_retries_once_without_it_and_remembers():
    client, completions = fake_client(reject_json_mode=True)
    memo: set[str] = set()
    with mock.patch.object(main, "nvidia", return_value=client), mock.patch.object(main, "_JSON_MODE_UNSUPPORTED", memo):
        parsed = main.call_nvidia_vision(b"jpeg bytes", "image/jpeg")
        assert len(parsed.items) == 14
        assert len(completions.calls) == 2
        assert completions.calls[0]["response_format"] == {"type": "json_object"}
        assert "response_format" not in completions.calls[1]
        # The retry is the same request minus response_format.
        first_without = {k: v for k, v in completions.calls[0].items() if k != "response_format"}
        assert first_without == completions.calls[1]
        # The rejection is remembered per model, so the next scan skips JSON mode outright.
        assert memo == {completions.calls[0]["model"]}
        main.call_nvidia_vision(b"jpeg bytes", "image/jpeg")
        assert len(completions.calls) == 3
        assert "response_format" not in completions.calls[2]


def test_bad_request_that_persists_is_not_blamed_on_json_mode():
    client, completions = fake_client(reject_all=True)
    memo: set[str] = set()
    with mock.patch.object(main, "nvidia", return_value=client), mock.patch.object(main, "_JSON_MODE_UNSUPPORTED", memo):
        try:
            main.call_nvidia_vision(b"jpeg bytes", "image/jpeg")
        except openai.BadRequestError:
            pass
        else:
            raise AssertionError("expected the second 400 to propagate")
    assert len(completions.calls) == 2  # tried with, retried without, gave up
    assert memo == set()  # a 400 that survives the retry was about something else


def test_other_errors_become_502_after_the_retry_loop():
    client, completions = fake_client(content="Sorry, I cannot read this image.")
    with env(LLM_PROVIDER="nvidia"), mock.patch.object(main, "nvidia", return_value=client):
        r = post_scan()
    assert r.status_code == 502, r.text
    assert r.json()["detail"].startswith("Could not parse receipt:")
    assert len(completions.calls) == 2  # /scan's own one retry


def test_empty_choices_and_malformed_json_are_clear_502s():
    # No choices at all (some gateways answer this way on a filtered request).
    empty = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: SimpleNamespace(choices=[]))))
    with env(LLM_PROVIDER="nvidia"), mock.patch.object(main, "nvidia", return_value=empty), mock.patch.object(main, "_JSON_MODE_UNSUPPORTED", set()):
        r = post_scan()
    assert r.status_code == 502, r.text
    assert "no choices" in r.json()["detail"]

    # Truncated JSON (max_tokens hit): the 502 says it was malformed, not just "list index".
    client, _ = fake_client(content=FENCED[: len(FENCED) // 2] + "}")
    with env(LLM_PROVIDER="nvidia"), mock.patch.object(main, "nvidia", return_value=client), mock.patch.object(main, "_JSON_MODE_UNSUPPORTED", set()):
        r = post_scan()
    assert r.status_code == 502, r.text
    assert "malformed JSON" in r.json()["detail"], r.text


def test_gemini_path_when_provider_unset_or_gemini():
    for value in (None, "gemini", " GEMINI ", "something-else"):
        gem = mock.Mock(return_value=main.ParsedReceipt.model_validate(CANNED))
        with (
            env(LLM_PROVIDER=value),
            mock.patch.object(main, "call_gemini", gem),
            mock.patch.object(main, "nvidia", side_effect=AssertionError("nvidia() must not be called")),
        ):
            r = post_scan("r.jpg", b"jpeg bytes", "image/jpeg")
        assert r.status_code == 200, (value, r.text)
        assert gem.call_count == 1, value
        assert gem.call_args.args == (b"jpeg bytes", "image/jpeg")
        assert r.json()["item_count"] == 14


def test_missing_nvidia_key_is_a_503():
    with env(LLM_PROVIDER="nvidia", NVIDIA_API_KEY=None), mock.patch.object(main, "_nvidia_client", None):
        r = post_scan()
    assert r.status_code == 503, r.text
    assert "NVIDIA_API_KEY" in r.json()["detail"]


def test_pdf_is_rejected_on_the_nvidia_path():
    client, completions = fake_client()
    with env(LLM_PROVIDER="nvidia"), mock.patch.object(main, "nvidia", return_value=client):
        r = post_scan("r.pdf", b"%PDF-1.4", "application/pdf")
    assert r.status_code == 400, r.text
    assert completions.calls == []


def test_health_reports_provider_without_leaking_the_key():
    placeholder = "set-for-this-test-only"
    with env(LLM_PROVIDER="nvidia", NVIDIA_API_KEY=placeholder, NVIDIA_VISION_MODEL=None, NVIDIA_BASE_URL=None):
        body = TestClient(main.app).get("/health").json()
    assert body["ok"] is True
    assert body["provider"] == "nvidia"
    assert body["vision_model"] == main.NVIDIA_DEFAULT_VISION_MODEL
    assert body["nvidia_base_url"] == main.NVIDIA_DEFAULT_BASE_URL
    assert body["nvidia_key_set"] is True
    assert placeholder not in json.dumps(body)
    assert "model" in body and "key_set" in body  # Gemini's, still needed by /recipes

    with env(LLM_PROVIDER="nvidia", NVIDIA_API_KEY=None, NVIDIA_VISION_MODEL="some/other-vl"):
        body = TestClient(main.app).get("/health").json()
    assert body["nvidia_key_set"] is False and body["vision_model"] == "some/other-vl"

    with env(LLM_PROVIDER=None):
        body = TestClient(main.app).get("/health").json()
    assert body["provider"] == "gemini"
    assert "vision_model" not in body and "nvidia_key_set" not in body


def test_parse_receipt_json_tolerates_fences_and_chatter():
    raw = json.dumps(CANNED)
    for text in (
        raw,
        f"```json\n{raw}\n```",
        f"```JSON\n{raw}\n```",
        f"```\n{raw}\n```",
        f"  \n```json\n{raw}```",
        f"Here is the receipt:\n{raw}\nLet me know if you need anything else.",
        f"Sure!\n```json\n{raw}\n```\nDone.",
    ):
        assert len(main.parse_receipt_json(text).items) == 14, text[:30]

    for bad in ("", "   ", "no json here", "```json\n```", "{not json}", None, '{"store_name": "x"}'):
        try:
            main.parse_receipt_json(bad)
        except (ValueError, TypeError):  # json errors and pydantic's ValidationError are ValueErrors
            pass
        else:
            raise AssertionError(f"expected a parse error for {bad!r}")


def test_big_image_is_downscaled_to_2048px_jpeg_and_small_ones_pass_through():
    from PIL import Image

    assert main._image_data_url(b"abc", "image/png") == "data:image/png;base64,YWJj"

    big = Image.effect_noise((3000, 2200), 60).convert("RGB")  # noise barely compresses: well over 4 MB
    buf = io.BytesIO()
    big.save(buf, format="PNG")
    png = buf.getvalue()
    assert len(png) > main.NVIDIA_MAX_IMAGE_BYTES, len(png)

    url = main._image_data_url(png, "image/png")
    assert url.startswith("data:image/jpeg;base64,")
    out = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
    assert out.format == "JPEG"
    assert max(out.size) == 2048, out.size
    assert abs(out.width / out.height - 3000 / 2200) < 0.01, out.size
    assert len(url) < len(png)


if __name__ == "__main__":
    tests = [obj for name, obj in list(globals().items()) if name.startswith("test_") and callable(obj)]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL  {test.__name__}: {exc!r}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
