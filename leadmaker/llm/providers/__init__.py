"""LLM provider implementations, imported lazily by leadmaker.llm.get_provider."""

from __future__ import annotations

REGISTRY: dict[str, str] = {
    "gemini": "leadmaker.llm.providers.gemini:GeminiProvider",
    "anthropic": "leadmaker.llm.providers.anthropic:AnthropicProvider",
    "openai_compat": "leadmaker.llm.providers.openai_compat:OpenAICompatProvider",
}

__all__ = ["REGISTRY"]
