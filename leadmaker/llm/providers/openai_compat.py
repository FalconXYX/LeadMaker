"""OpenAI-compatible Chat Completions provider (e.g. a local Ollama at http://localhost:11434/v1).

  * POST {LEADMAKER_LLM_BASE_URL}/chat/completions; `Authorization: Bearer $LEADMAKER_LLM_API_KEY` when set
    (local servers usually ignore it). LEADMAKER_LLM_MODEL is required -- there is no portable default.
  * Structured output: response_format json_schema (strict). Tools: `tools[].function` + tool_calls.
  * No client-side limits by default (local models are bounded by the machine, not a quota).
"""

from __future__ import annotations

import json
from typing import Any, Sequence

from ...http import HttpClient
from ..base import (
    ChatMessage, LlmOutputError, LlmProvider, LlmResponse, ToolCall, ToolSpec, parse_json_object,
)

DEFAULT_BASE_URL = "http://localhost:11434/v1"  # Ollama's OpenAI-compatible endpoint


class OpenAICompatProvider(LlmProvider):
    name = "openai_compat"

    def __init__(self, settings, *, model: str | None = None, limiter=None):
        super().__init__(settings, model=model, limiter=limiter)
        self.base_url = (settings.llm_base_url or DEFAULT_BASE_URL).rstrip("/")
        self.api_key = settings.llm_api_key

    def is_configured(self) -> tuple[bool, str]:
        if not self.model:
            return False, "LEADMAKER_LLM_MODEL must name the model for openai_compat"
        return True, ""

    @property
    def url(self) -> str:
        return f"{self.base_url}/chat/completions"

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def json_body(self, *, system: str, user: str, schema: dict[str, Any], max_output_tokens: int,
                  schema_name: str = "output") -> dict[str, Any]:
        return {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": schema_name, "schema": schema, "strict": True}},
            "max_tokens": max_output_tokens,
        }

    def chat_body(self, *, system: str, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec],
                  tool_choice: str, max_output_tokens: int) -> dict[str, Any]:
        msgs: list[dict[str, Any]] = [{"role": "system", "content": system}] if system else []
        for m in messages:
            if m.role == "tool":
                msgs.append({"role": "tool", "tool_call_id": m.tool_call_id or "", "content": m.content})
            elif m.role == "assistant":
                msg: dict[str, Any] = {"role": "assistant", "content": m.content or None}
                if m.tool_calls:
                    msg["tool_calls"] = [{"id": c.id, "type": "function",
                                          "function": {"name": c.name, "arguments": json.dumps(c.arguments)}}
                                         for c in m.tool_calls]
                msgs.append(msg)
            else:
                msgs.append({"role": "user", "content": m.content})
        body: dict[str, Any] = {"model": self.model, "messages": msgs, "max_tokens": max_output_tokens}
        if tools:
            body["tools"] = [{"type": "function", "function": {"name": t.name, "description": t.description,
                                                                "parameters": t.parameters}} for t in tools]
            body["tool_choice"] = (tool_choice if tool_choice in ("auto", "none", "required")
                                   else {"type": "function", "function": {"name": tool_choice}})
        return body

    def parse_response(self, payload: dict[str, Any], *, want_json: bool) -> LlmResponse:
        choices = payload.get("choices") or []
        if not choices:
            raise LlmOutputError("no choices in response", provider=self.name)
        choice = choices[0]
        finish = choice.get("finish_reason")
        if finish == "length":
            raise LlmOutputError("model output truncated at max_tokens", provider=self.name)
        if finish == "content_filter":
            raise LlmOutputError("model output blocked by content filter", provider=self.name)
        msg = choice.get("message") or {}
        text = msg.get("content") or ""
        calls = []
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError as e:
                raise LlmOutputError(f"invalid tool arguments from model: {e}", provider=self.name) from e
            calls.append(ToolCall(id=str(tc.get("id") or ""), name=str(fn.get("name") or ""),
                                  arguments=args if isinstance(args, dict) else {}))
        u = payload.get("usage") or {}
        usage = {k: u[src] for k, src in (("input_tokens", "prompt_tokens"), ("output_tokens", "completion_tokens"))
                 if isinstance(u.get(src), int)}
        return LlmResponse(provider=self.name, model=str(payload.get("model") or self.model), text=text,
                           data=parse_json_object(text, self.name) if want_json else None, tool_calls=calls,
                           stop_reason=finish, usage=usage, raw_content=None)

    async def generate_json(self, http: HttpClient, *, system: str, user: str, schema: dict[str, Any],
                            max_output_tokens: int = 8000, schema_name: str = "output") -> LlmResponse:
        body = self.json_body(system=system, user=user, schema=schema, max_output_tokens=max_output_tokens,
                              schema_name=schema_name)
        return self.parse_response(await self.post_json(http, self.url, self._headers(), body), want_json=True)

    async def chat(self, http: HttpClient, *, system: str, messages: Sequence[ChatMessage],
                   tools: Sequence[ToolSpec] = (), tool_choice: str = "auto",
                   max_output_tokens: int = 4096) -> LlmResponse:
        body = self.chat_body(system=system, messages=messages, tools=tools, tool_choice=tool_choice,
                              max_output_tokens=max_output_tokens)
        return self.parse_response(await self.post_json(http, self.url, self._headers(), body), want_json=False)


__all__ = ["DEFAULT_BASE_URL", "OpenAICompatProvider"]
