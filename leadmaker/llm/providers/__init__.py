"""LLM provider implementations, imported lazily by leadmaker.llm.get_provider."""

from __future__ import annotations

REGISTRY: dict[str, str] = {
    "gemini": "leadmaker.llm.providers.gemini:GeminiProvider",
    "anthropic": "leadmaker.llm.providers.anthropic:AnthropicProvider",
    "openai_compat": "leadmaker.llm.providers.openai_compat:OpenAICompatProvider",
    # Deterministic test provider: only by name, and only under pytest or with LEADMAKER_ALLOW_FAKE_LLM=1.
    "fake": "leadmaker.llm.providers.fake:FakeProvider",
}

__all__ = ["REGISTRY"]
