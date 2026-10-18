"""Anthropic Claude provider (Messages API through the official SDK) -- the production provider.

  * Optional dependency: the `anthropic` SDK is imported lazily (extra `leadmaker[llm]`); the SDK does
    its own HTTP with retries/backoff for 408/409/429/5xx (honouring retry-after), so this provider does
    not go through HttpClient -- the official SDK is the supported way to call the API.
  * Structured output: `output_config.format` json_schema; the static system prompt is marked
    `cache_control` (prompt caching).
  * Bulk runs: `json_params()` / `parse_message()` are the exact request and parser, so a runner can
    submit the same requests through the Message Batches API (50% price) and parse results identically.
  * Limits: paid API, no daily request quota by default (LEADMAKER_LLM_RPM / _RPD still apply).
    A 400 "credit balance is too low" is reported as LlmQuotaExceeded(scope="billing").
"""

from __future__ import annotations

import importlib
import importlib.util
from typing import Any, Sequence

from ...http import HttpClient
from ..base import (
    ChatMessage, LlmApiError, LlmAuthError, LlmError, LlmOutputError, LlmProvider, LlmQuotaExceeded,
    LlmRateLimited, LlmResponse, ToolCall, ToolSpec, parse_json_object,
)

CLIENT_TIMEOUT_S = 120.0
CLIENT_MAX_RETRIES = 2  # SDK retries 408/409/429/5xx/connection errors with backoff


def _get(block: Any, key: str, default: Any = None) -> Any:
    if isinstance(block, dict):
        return block.get(key, default)
    return getattr(block, key, default)


def _as_dict(block: Any) -> Any:
    """SDK content block -> plain dict (for replaying an assistant turn)."""
    if isinstance(block, dict):
        return block
    dump = getattr(block, "model_dump", None)
    return dump(exclude_none=True) if callable(dump) else dict(vars(block))


def describe_api_error(e: BaseException) -> str:
    """Readable error for the enrichments table, using the SDK's typed attributes when present."""
    status = getattr(e, "status_code", None)
    rid = getattr(e, "request_id", None)
    msg = getattr(e, "message", None) or str(e)
    out = type(e).__name__
    if status is not None:
        out += f" ({status})"
    out += f": {msg}"
    if rid:
        out += f" [request_id={rid}]"
    return out


def usage_dict(message: Any) -> dict[str, int]:
    usage = _get(message, "usage")
    if usage is None:
        return {}
    out = {}
    for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
        v = _get(usage, k)
        if isinstance(v, int):
            out[k] = v
    return out


def extract_payload(message: Any) -> dict[str, Any]:
    """Get the JSON object out of a Messages API response (structured-output text or a tool_use block)."""
    stop = _get(message, "stop_reason")
    if stop == "refusal":
        details = _get(message, "stop_details")
        cat = _get(details, "category") if details is not None else None
        raise LlmOutputError(f"model refused (category={cat})", provider="anthropic")
    if stop == "max_tokens":
        raise LlmOutputError("model output truncated at max_tokens", provider="anthropic")
    texts: list[str] = []
    for block in _get(message, "content", None) or []:
        btype = _get(block, "type")
        if btype == "tool_use":
            payload = _get(block, "input")
            if isinstance(payload, dict):
                return payload
        elif btype == "text":
            texts.append(_get(block, "text", "") or "")
    raw = "".join(texts).strip()
    if not raw:
        raise LlmOutputError(f"no JSON output in response (stop_reason={stop})", provider="anthropic")
    return parse_json_object(raw, "anthropic")


class AnthropicProvider(LlmProvider):
    name = "anthropic"

    def __init__(self, settings, *, model: str | None = None, limiter=None, client: Any | None = None):
        super().__init__(settings, model=model, limiter=limiter)
        self._client = client  # injected (tests / custom transport) or created lazily from the SDK

    def is_configured(self) -> tuple[bool, str]:
        if self._client is not None:
            return True, ""
        if not self.settings.anthropic_api_key:
            return False, "ANTHROPIC_API_KEY not set"
        if importlib.util.find_spec("anthropic") is None:
            return False, "anthropic package not installed (pip install 'leadmaker[llm]')"
        return True, ""

    def _get_client(self) -> Any:
        if self._client is None:
            anthropic = importlib.import_module("anthropic")
            self._client = anthropic.AsyncAnthropic(
                api_key=self.settings.anthropic_api_key, max_retries=CLIENT_MAX_RETRIES, timeout=CLIENT_TIMEOUT_S,
            )
        return self._client

    # -- request building (shared by live calls and the Batches API path) ----------
    def json_params(self, *, system: str, user: str, schema: dict[str, Any], max_output_tokens: int = 8000
                    ) -> dict[str, Any]:
        return {
            "model": self.model,
            "max_tokens": max_output_tokens,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": user}],
            "output_config": {"format": {"type": "json_schema", "schema": schema}},
        }

    def chat_params(self, *, system: str, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec],
                    tool_choice: str, max_output_tokens: int) -> dict[str, Any]:
        params: dict[str, Any] = {"model": self.model, "max_tokens": max_output_tokens,
                                  "messages": self.messages(messages)}
        if system:
            params["system"] = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
        if tools:
            params["tools"] = [{"name": t.name, "description": t.description, "input_schema": t.parameters}
                               for t in tools]
            # Note: some current models reject forced tool use ("any"/"tool"); "auto" always works.
            params["tool_choice"] = (
                {"type": tool_choice} if tool_choice in ("auto", "none")
                else {"type": "any"} if tool_choice == "required" else {"type": "tool", "name": tool_choice}
            )
        return params

    def messages(self, messages: Sequence[ChatMessage]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for m in messages:
            if m.role == "tool":
                block = {"type": "tool_result", "tool_use_id": m.tool_call_id or "", "content": m.content}
                if m.is_error:
                    block["is_error"] = True
                prev = out[-1] if out else None
                if (prev and prev["role"] == "user" and isinstance(prev["content"], list)
                        and all(b.get("type") == "tool_result" for b in prev["content"])):
                    prev["content"].append(block)  # parallel calls: every result in one user turn
                else:
                    out.append({"role": "user", "content": [block]})
            elif m.role == "assistant":
                if m.raw and m.raw.get("provider") == self.name and m.raw.get("content"):
                    out.append({"role": "assistant", "content": m.raw["content"]})  # keeps thinking blocks
                    continue
                blocks: list[dict[str, Any]] = [{"type": "text", "text": m.content}] if m.content else []
                blocks += [{"type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments} for c in m.tool_calls]
                out.append({"role": "assistant", "content": blocks or m.content})
            else:
                out.append({"role": "user", "content": m.content})
        return out

    # -- response parsing ------------------------------------------------------------
    def parse_message(self, message: Any, *, want_json: bool) -> LlmResponse:
        data = extract_payload(message) if want_json else None
        if not want_json and _get(message, "stop_reason") == "refusal":
            raise LlmOutputError("model refused", provider=self.name)
        content = list(_get(message, "content", None) or [])
        texts = [(_get(b, "text", "") or "") for b in content if _get(b, "type") == "text"]
        calls = [ToolCall(id=str(_get(b, "id") or ""), name=str(_get(b, "name") or ""),
                          arguments=_get(b, "input") if isinstance(_get(b, "input"), dict) else {})
                 for b in content if _get(b, "type") == "tool_use"]
        return LlmResponse(
            provider=self.name, model=str(_get(message, "model") or self.model), text="".join(texts), data=data,
            tool_calls=calls, stop_reason=_get(message, "stop_reason"), usage=usage_dict(message),
            raw_content=[_as_dict(b) for b in content],
        )

    def _map_error(self, e: Exception) -> LlmError:
        status = getattr(e, "status_code", None)
        text = describe_api_error(e)
        if status == 429:
            return LlmRateLimited(text, provider=self.name)
        if status in (401, 403, 404):
            return LlmAuthError(text, provider=self.name, status=status)
        if status == 400 and "credit balance" in text.lower():
            return LlmQuotaExceeded(text, provider=self.name, status=400, scope="billing")
        return LlmApiError(text, provider=self.name, status=status)

    async def _create(self, params: dict[str, Any]) -> Any:
        if self._fatal is not None:
            raise self._fatal
        await self.limiter.acquire(abort=lambda: self._fatal)  # another lead may fail meanwhile
        try:
            return await self._get_client().messages.create(**params)
        except Exception as e:  # SDK raises typed APIStatusError/APIConnectionError/APITimeoutError
            err = self._map_error(e)
            if isinstance(err, (LlmAuthError, LlmQuotaExceeded)):
                self._fatal = err
            raise err from e

    # -- calls ----------------------------------------------------------------------------
    async def generate_json(self, http: HttpClient, *, system: str, user: str, schema: dict[str, Any],
                            max_output_tokens: int = 8000, schema_name: str = "output") -> LlmResponse:
        message = await self._create(self.json_params(system=system, user=user, schema=schema,
                                                      max_output_tokens=max_output_tokens))
        return self.parse_message(message, want_json=True)

    async def chat(self, http: HttpClient, *, system: str, messages: Sequence[ChatMessage],
                   tools: Sequence[ToolSpec] = (), tool_choice: str = "auto",
                   max_output_tokens: int = 4096) -> LlmResponse:
        message = await self._create(self.chat_params(system=system, messages=messages, tools=tools,
                                                      tool_choice=tool_choice, max_output_tokens=max_output_tokens))
        return self.parse_message(message, want_json=False)


__all__ = ["AnthropicProvider", "describe_api_error", "extract_payload", "usage_dict"]
