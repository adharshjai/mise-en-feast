"""
Vercel entry point: serves the FastAPI backend from ../backend as a Python
function, mounted under /api so the static frontend can call it same-origin.

  /api/health        -> backend /health
  /api/scan          -> backend /scan          (Gemini: receipt OCR)
  /api/recipes       -> backend /recipes        (Gemini: the recipe deck)
  /api/chat          -> backend /chat           (Claude/Bedrock: in-app assistant + tools)
  /api/recipe-detail -> backend /recipe-detail  (Claude/Bedrock: recipe steps on demand)
  /api/cook          -> backend /cook
  /api/identify      -> backend /identify
  /api/dish-image    -> backend /dish-image    (Gemini: a picture of a dish, cached a year)
  /api/meal-plan     -> backend /meal-plan     (Gemini: breakfast/lunch/dinner for the week)

Set GEMINI_API_KEY (and optionally GEMINI_MODEL and GEMINI_IMAGE_MODEL) for the Gemini features, and the
AWS Bedrock variables for the Claude chatbot (AWS_BEARER_TOKEN_BEDROCK, AWS_REGION,
BEDROCK_MODEL_ID), in the Vercel project's environment variables. Locally, run
backend/ with uvicorn instead (see backend/README.md).
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, "backend")
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from fastapi import FastAPI  # noqa: E402

from main import app as backend_app  # noqa: E402  (backend/main.py)

_wrapper = FastAPI(title="mise en feast API (Vercel)")
_wrapper.mount("/api", backend_app)


async def app(scope, receive, send):
    """ASGI shim: vercel.json's trailingSlash turns /api/scan into /api/scan/,
    which FastAPI would bounce back. Strip it before routing."""
    if scope.get("type") == "http":
        path = scope.get("path", "")
        if len(path) > 1 and path.endswith("/"):
            scope = dict(scope, path=path.rstrip("/"), raw_path=path.rstrip("/").encode())
    await _wrapper(scope, receive, send)
