"""
Claude on AWS Bedrock — the reasoning engine for mise en feast.

Gemini still reads receipts (backend/main.py /scan). Everything that needs real
reasoning about the user's pantry, preferences and meals goes to Claude Sonnet
through Bedrock's Converse API:

  - recipe generation and pantry matching   (backend/recipes.py)
  - the chatbot with controlled app tools    (backend/chat.py)

All AWS credentials stay server-side. Nothing here is ever sent to the browser.

Auth: Bedrock accepts a bearer API key through the AWS_BEARER_TOKEN_BEDROCK
environment variable (botocore reads it automatically), or ordinary AWS
credentials (access key / role). Either works; the bearer token is what the
project's .env ships with.

Two model tiers, so each job runs on the right-sized model:
  - "smart"  (model_smart) — heavier reasoning: recipe generation. Point this at
             Opus for the best recipes, or leave it on Sonnet for speed.
  - "fast"   (model_fast)  — the chatbot's turn-by-turn tool routing and short
             replies, which are latency-sensitive and don't need Opus.
Set them independently; if the fast id is unset it falls back to the smart id, so
nothing changes until you opt in.

Environment variables:
  AWS_BEARER_TOKEN_BEDROCK   Bedrock API key (preferred), OR
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   standard AWS credentials
  AWS_REGION                 e.g. us-east-2  (default us-east-1)
  BEDROCK_MODEL_ID           the "smart" model id (recipes). e.g.
                             global.anthropic.claude-opus-4-... or ...-sonnet-4-6
  BEDROCK_MODEL_ID_FAST      the "fast" model id (chat). e.g. a Sonnet/Haiku
                             inference profile. Falls back to BEDROCK_MODEL_ID.
"""

from __future__ import annotations

import json
import os
import re

from fastapi import HTTPException

DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-6"
DEFAULT_REGION = "us-east-1"

_client = None


def region() -> str:
    return os.getenv("AWS_REGION", "").strip() or os.getenv("AWS_DEFAULT_REGION", "").strip() or DEFAULT_REGION


def model_smart() -> str:
    """The heavier-reasoning model (recipe generation). Point BEDROCK_MODEL_ID at Opus for
    the best recipes, or leave it on Sonnet for speed. Never hardcoded."""
    return os.getenv("BEDROCK_MODEL_ID", "").strip() or DEFAULT_MODEL_ID


def model_fast() -> str:
    """The latency-sensitive model (chatbot tool routing / short replies). Falls back to the
    smart model when BEDROCK_MODEL_ID_FAST is unset, so tiering is purely opt-in."""
    return os.getenv("BEDROCK_MODEL_ID_FAST", "").strip() or model_smart()


# Back-compat alias: the default model is the smart one.
def model_id() -> str:
    return model_smart()


def credentials_present() -> bool:
    """True when Bedrock has some way to authenticate (bearer token or AWS creds)."""
    if os.getenv("AWS_BEARER_TOKEN_BEDROCK", "").strip():
        return True
    if os.getenv("AWS_ACCESS_KEY_ID", "").strip() and os.getenv("AWS_SECRET_ACCESS_KEY", "").strip():
        return True
    # A shared profile or an attached IAM role also counts; let botocore decide.
    return bool(os.getenv("AWS_PROFILE", "").strip())


def client():
    """The Bedrock Runtime client, built on first use so a missing key is a clear 503."""
    global _client
    if _client is None:
        if not credentials_present():
            raise HTTPException(
                503,
                "Bedrock is not configured. Set AWS_BEARER_TOKEN_BEDROCK (or AWS credentials) "
                "and AWS_REGION in backend/.env (local) or the Vercel project's environment variables.",
            )
        try:
            import boto3  # imported here so the app still starts if boto3 is absent
        except ImportError as exc:  # pragma: no cover
            raise HTTPException(503, "boto3 is not installed. Run: pip install -r backend/requirements.txt") from exc
        _client = boto3.client("bedrock-runtime", region_name=region())
    return _client


# ---------------------------------------------------------------------------
# Converse
# ---------------------------------------------------------------------------


def converse(
    messages: list[dict],
    *,
    system: str | None = None,
    tools: list[dict] | None = None,
    tool_choice: dict | None = None,
    max_tokens: int = 2048,
    temperature: float = 0.4,
    model: str | None = None,
) -> dict:
    """One Bedrock Converse call. Returns the raw response dict.

    `messages` is the Converse message list ([{role, content:[blocks]}]).
    `tools` is a list of Converse tool specs; `tool_choice` an optional
    {'auto'|'any': {}} or {'tool': {'name': ...}}. Errors become a 502 so the
    endpoint can report them the same way the Gemini paths do.
    """
    kwargs: dict = {
        "modelId": model or model_id(),
        "messages": messages,
        "inferenceConfig": {"maxTokens": max_tokens, "temperature": temperature},
    }
    if system:
        kwargs["system"] = [{"text": system}]
    if tools:
        tool_config: dict = {"tools": tools}
        if tool_choice:
            tool_config["toolChoice"] = tool_choice
        kwargs["toolConfig"] = tool_config

    try:
        return client().converse(**kwargs)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — botocore ClientError etc.
        raise HTTPException(502, f"Bedrock Converse call failed: {exc}") from exc


def output_message(response: dict) -> dict:
    """The assistant message from a Converse response ({role, content:[blocks]})."""
    return (response.get("output") or {}).get("message") or {"role": "assistant", "content": []}


def response_text(response: dict) -> str:
    """Concatenated text blocks of a Converse response."""
    parts = [b.get("text", "") for b in output_message(response).get("content", []) if "text" in b]
    return "".join(parts).strip()


def tool_uses(response: dict) -> list[dict]:
    """The toolUse blocks Claude emitted, each {toolUseId, name, input}."""
    return [b["toolUse"] for b in output_message(response).get("content", []) if "toolUse" in b]


def extract_json_object(text: str) -> dict:
    """Model text -> dict, tolerating a code fence or chatter around the object."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("the model returned an empty response")
    fenced = re.match(r"^\s*```(?:json)?\s*\n?(.*?)\n?\s*```\s*$", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError(f"no JSON object in the model response: {text.strip()[:120]!r}")
    return json.loads(text[start : end + 1])
