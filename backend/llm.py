"""One Gemini call that has to come back as a given pydantic model.

Used by recipes.py (dish ideas, then the recipes themselves) and identify.py
(photo of a dish). `contents` is whatever the SDK takes: a prompt string, or a
list of parts when there is an image.
"""

from __future__ import annotations

import json
import os

from google.genai import types

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")


def generate_json(client, contents, schema, model: str | None = None):
    """Ask for `schema` and return an instance of it. Raises on anything else."""
    response = client.models.generate_content(
        model=model or MODEL,
        contents=contents,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=schema,
            # No temperature / top_p / top_k. Gemini 3.x is tuned for defaults
            # and overriding them makes structured output worse, not better.
        ),
    )

    if response.parsed is not None:
        return response.parsed

    # The SDK could not hydrate the model; parse the text ourselves.
    text = response.text or ""
    if not text.strip():
        raise ValueError("the model returned an empty response")
    return schema.model_validate(json.loads(text))
