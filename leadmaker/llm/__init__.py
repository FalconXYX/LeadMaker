"""Provider-agnostic LLM layer: one interface for the batch pipeline and the on-demand assistant.

    provider = get_provider(settings)            # LEADMAKER_LLM_PROVIDER / key-based auto selection
    r = await provider.generate_json(http, system=..., user=..., schema=...)   # r.data
    r = await provider.chat(http, system=..., messages=[ChatMessage.user("...")], tools=[ToolSpec(...)])
    # r.text, r.tool_calls; append r.message then ChatMessage.tool_result(call, result) and call again

Providers: gemini (demo, free tier), anthropic (production), openai_compat (e.g. a local Ollama).
See leadmaker.llm.base for the error types and leadmaker.llm.ratelimit for the client-side budget.
"""

from __future__ import annotations

import importlib
from typing import Any

from ..config import Settings
from .base import (
    ChatMessage, LlmApiError, LlmAuthError, LlmError, LlmOutputError, LlmProvider, LlmQuotaExceeded,
    LlmRateLimited, LlmResponse, ToolCall, ToolSpec,
)
from .providers import REGISTRY


def provider_class(name: str) -> type[LlmProvider]:
    if name not in REGISTRY:
        raise ValueError(f"unknown LLM provider {name!r}; available: {list(REGISTRY)}")
    module, _, cls = REGISTRY[name].partition(":")
    return getattr(importlib.import_module(module), cls)


def get_provider(settings: Settings, name: str | None = None, **kw: Any) -> LlmProvider | None:
    """The configured provider (or `name`), or None when no provider is configured."""
    name = name or settings.llm_provider
    if name is None:
        return None
    return provider_class(name)(settings, **kw)


__all__ = [
    "ChatMessage", "LlmApiError", "LlmAuthError", "LlmError", "LlmOutputError", "LlmProvider",
    "LlmQuotaExceeded", "LlmRateLimited", "LlmResponse", "ToolCall", "ToolSpec", "get_provider",
    "provider_class",
]
