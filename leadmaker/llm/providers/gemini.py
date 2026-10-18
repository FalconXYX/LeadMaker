"""Google Gemini API provider (REST, v1beta models.generateContent) -- the demo's free-tier provider.

  * Auth: GEMINI_API_KEY (or GOOGLE_API_KEY) in the `x-goog-api-key` header (never in the URL).
  * Structured output: generationConfig.responseMimeType=application/json + responseSchema. responseSchema
    is the OpenAPI subset (no additionalProperties, nullable instead of type unions), so JSON schemas are
    converted by `to_gemini_schema`; propertyOrdering keeps fields in our order (e.g. name before evidence).
  * Tools: tools[].functionDeclarations + toolConfig.functionCallingConfig. A model turn's parts are kept
    verbatim in ChatMessage.raw because Gemini 3 attaches `thoughtSignature`s that must be sent back.
  * Limits: free-tier RPM/RPD are no longer published (they are shown per project in AI Studio) and the
    RPD resets at midnight Pacific. Defaults are deliberately conservative; set LEADMAKER_LLM_RPM/_RPD to
    what AI Studio shows. A 429 whose QuotaFailure names a per-day quota marks the day as spent; other
    429s honour RetryInfo.retryDelay. Free-tier prompts may be used by Google to improve its products.
"""

from __future__ import annotations

import json
import re
from typing import Any, Sequence

from ...http import HttpClient, Response
from ..base import (
    ChatMessage, LlmApiError, LlmAuthError, LlmError, LlmOutputError, LlmProvider, LlmQuotaExceeded,
    LlmRateLimited, LlmResponse, ToolCall, ToolSpec, parse_json_object, retry_after_seconds,
)

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
# finishReason values that mean the answer is unusable (STOP is the normal end; MAX_TOKENS is truncation).
BAD_FINISH = {"SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
              "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY", "UNEXPECTED_TOOL_CALL", "OTHER"}
SYNTH_ID_PREFIX = "gemini-call-"  # ids we invent when the API does not return one (not echoed back)
_SCHEMA_KEYS = {"description", "format", "enum", "nullable", "minItems", "maxItems", "minimum", "maximum",
                "title", "minLength", "maxLength", "pattern"}


def to_gemini_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """JSON schema -> Gemini responseSchema / function `parameters` (OpenAPI 3.0 subset)."""
    out: dict[str, Any] = {}
    typ = schema.get("type")
    nullable = False
    if isinstance(typ, list):
        nullable = "null" in typ
        typ = next((t for t in typ if t != "null"), "string")
    variants = schema.get("anyOf")
    if typ is None and isinstance(variants, list):  # anyOf [X, {"type": "null"}] -> nullable X
        non_null = [v for v in variants if v.get("type") != "null"]
        nullable = len(non_null) < len(variants)
        if len(non_null) == 1:
            inner = to_gemini_schema(non_null[0])
            if nullable:
                inner["nullable"] = True
            return inner
        out["anyOf"] = [to_gemini_schema(v) for v in non_null]
    if typ:
        out["type"] = str(typ).upper()
    for k in _SCHEMA_KEYS:
        if k in schema:
            out[k] = schema[k]
    if "enum" in out:
        out["enum"] = [str(v) for v in out["enum"] if v is not None]
    if nullable:
        out["nullable"] = True
    if isinstance(schema.get("properties"), dict):
        out["properties"] = {k: to_gemini_schema(v) for k, v in schema["properties"].items()}
        out["propertyOrdering"] = list(schema["properties"])
        if schema.get("required"):
            out["required"] = list(schema["required"])
    if isinstance(schema.get("items"), dict):
        out["items"] = to_gemini_schema(schema["items"])
    return out


def _seconds(delay: Any) -> float | None:
    m = re.fullmatch(r"\s*([\d.]+)s\s*", str(delay or ""))
    return float(m.group(1)) if m else None


class GeminiProvider(LlmProvider):
    name = "gemini"
    default_rpm = 5
    default_rpd = 200

    def __init__(self, settings, *, model: str | None = None, limiter=None, api_key: str | None = None):
        super().__init__(settings, model=model, limiter=limiter)
        self.api_key = api_key or settings.gemini_api_key
        # LEADMAKER_LLM_BASE_URL redirects Gemini only when LEADMAKER_LLM_PROVIDER=gemini is explicit. In auto
        # mode that variable is meant for openai_compat (Ollama, OpenRouter...), and a Gemini key that is still
        # exported must never be sent to it.
        explicit = settings.llm_provider_setting == self.name
        base = settings.llm_base_url if explicit and settings.llm_base_url else BASE_URL
        self.base_url = base.rstrip("/")

    def is_configured(self) -> tuple[bool, str]:
        if not self.api_key:
            return False, "GEMINI_API_KEY (or GOOGLE_API_KEY) not set"
        return True, ""

    @property
    def url(self) -> str:
        return f"{self.base_url}/models/{self.model}:generateContent"

    def _headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self.api_key or "", "Content-Type": "application/json"}

    # -- request building --------------------------------------------------------
    def json_body(self, *, system: str, user: str, schema: dict[str, Any], max_output_tokens: int) -> dict[str, Any]:
        return {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": to_gemini_schema(schema),
                "maxOutputTokens": max_output_tokens,
            },
        }

    def chat_body(self, *, system: str, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec],
                  tool_choice: str, max_output_tokens: int) -> dict[str, Any]:
        body: dict[str, Any] = {
            "contents": self.contents(messages),
            "generationConfig": {"maxOutputTokens": max_output_tokens},
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if tools:
            body["tools"] = [{"functionDeclarations": [
                {"name": t.name, "description": t.description, "parameters": to_gemini_schema(t.parameters)}
                for t in tools
            ]}]
            cfg: dict[str, Any] = {"mode": {"auto": "AUTO", "none": "NONE", "required": "ANY"}.get(tool_choice, "ANY")}
            if tool_choice not in ("auto", "none", "required"):
                cfg["allowedFunctionNames"] = [tool_choice]
            body["toolConfig"] = {"functionCallingConfig": cfg}
        return body

    def contents(self, messages: Sequence[ChatMessage]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for m in messages:
            if m.role == "tool":
                result = _as_struct(m.content)
                fr: dict[str, Any] = {"name": m.name or "", "response": {"error": result} if m.is_error else result}
                if m.tool_call_id and not m.tool_call_id.startswith(SYNTH_ID_PREFIX):
                    fr["id"] = m.tool_call_id
                part = {"functionResponse": fr}
                if out and out[-1]["role"] == "user" and all("functionResponse" in p for p in out[-1]["parts"]):
                    out[-1]["parts"].append(part)  # parallel calls: all results in one turn
                else:
                    out.append({"role": "user", "parts": [part]})
            elif m.role == "assistant":
                if m.raw and m.raw.get("provider") == self.name and m.raw.get("content"):
                    out.append({"role": "model", "parts": m.raw["content"]})  # verbatim (thought signatures)
                    continue
                parts: list[dict[str, Any]] = [{"text": m.content}] if m.content else []
                for c in m.tool_calls:
                    fc: dict[str, Any] = {"name": c.name, "args": c.arguments}
                    if not c.id.startswith(SYNTH_ID_PREFIX):
                        fc["id"] = c.id
                    parts.append({"functionCall": fc})
                out.append({"role": "model", "parts": parts or [{"text": ""}]})
            else:
                out.append({"role": "user", "parts": [{"text": m.content}]})
        return out

    # -- response parsing ----------------------------------------------------------
    def classify_error(self, resp: Response) -> LlmError:
        try:
            err = (resp.json() or {}).get("error") or {}
        except (ValueError, AttributeError):
            err = {}
        code = str(err.get("status") or "")
        message = str(err.get("message") or (resp.text or "")[:300])
        reasons, quota_ids, retry_delay = [], [], None
        for d in err.get("details") or []:
            if not isinstance(d, dict):
                continue
            if d.get("reason"):
                reasons.append(str(d["reason"]))
            for v in d.get("violations") or []:
                if isinstance(v, dict) and v.get("quotaId"):
                    quota_ids.append(str(v["quotaId"]))
            if d.get("retryDelay"):
                retry_delay = _seconds(d["retryDelay"])
        text = f"HTTP {resp.status} {code}" + (f" [{','.join(reasons + quota_ids)}]" if reasons or quota_ids else "")
        text += f": {message}"
        if resp.status == 429:
            if any("perday" in q.lower() for q in quota_ids):
                return LlmQuotaExceeded(text, provider=self.name, status=429, resets_at=self.limiter.resets_at())
            delay = retry_delay if retry_delay is not None else retry_after_seconds(resp.headers)
            return LlmRateLimited(text, provider=self.name, retry_after=delay)
        # FAILED_PRECONDITION is the account, not the request ("User location is not supported for the API use",
        # free tier not available in this country): every lead would burn a request on it, so stop the run.
        if (resp.status in (401, 403) or code == "FAILED_PRECONDITION"
                or any(r.startswith("API_KEY") or r in {"SERVICE_DISABLED", "BILLING_DISABLED"} for r in reasons)):
            return LlmAuthError(text, provider=self.name, status=resp.status)
        if resp.status == 404:  # unknown / retired model id: every call would fail
            return LlmAuthError(text, provider=self.name, status=404)
        return LlmApiError(text, provider=self.name, status=resp.status)

    def parse_response(self, payload: dict[str, Any], *, want_json: bool) -> LlmResponse:
        cands = payload.get("candidates") or []
        if not cands:
            block = (payload.get("promptFeedback") or {}).get("blockReason")
            raise LlmOutputError(f"prompt blocked ({block})" if block else "no candidates in response",
                                 provider=self.name)
        cand = cands[0]
        finish = cand.get("finishReason")
        if finish == "MAX_TOKENS":
            raise LlmOutputError("model output truncated at maxOutputTokens", provider=self.name)
        if finish in BAD_FINISH:
            raise LlmOutputError(f"model stopped with finishReason={finish}", provider=self.name)
        parts = (cand.get("content") or {}).get("parts") or []
        texts: list[str] = []
        calls: list[ToolCall] = []
        for i, p in enumerate(parts):
            if p.get("thought"):
                continue  # thought summaries are not answer text
            if "text" in p:
                texts.append(p.get("text") or "")
            fc = p.get("functionCall")
            if isinstance(fc, dict):
                args = fc.get("args")
                calls.append(ToolCall(id=str(fc.get("id") or f"{SYNTH_ID_PREFIX}{i}"), name=str(fc.get("name") or ""),
                                      arguments=args if isinstance(args, dict) else {}))
        text = "".join(texts)
        meta = payload.get("usageMetadata") or {}
        usage = {k: meta[src] for k, src in (
            ("input_tokens", "promptTokenCount"), ("output_tokens", "candidatesTokenCount"),
            ("thinking_tokens", "thoughtsTokenCount"), ("cache_read_input_tokens", "cachedContentTokenCount"),
        ) if isinstance(meta.get(src), int)}
        return LlmResponse(
            provider=self.name, model=str(payload.get("modelVersion") or self.model), text=text,
            data=parse_json_object(text, self.name) if want_json else None, tool_calls=calls,
            stop_reason=finish, usage=usage, raw_content=parts,
        )

    # -- calls -------------------------------------------------------------------------
    async def generate_json(self, http: HttpClient, *, system: str, user: str, schema: dict[str, Any],
                            max_output_tokens: int = 8000, schema_name: str = "output") -> LlmResponse:
        body = self.json_body(system=system, user=user, schema=schema, max_output_tokens=max_output_tokens)
        return self.parse_response(await self.post_json(http, self.url, self._headers(), body), want_json=True)

    async def chat(self, http: HttpClient, *, system: str, messages: Sequence[ChatMessage],
                   tools: Sequence[ToolSpec] = (), tool_choice: str = "auto",
                   max_output_tokens: int = 4096) -> LlmResponse:
        body = self.chat_body(system=system, messages=messages, tools=tools, tool_choice=tool_choice,
                              max_output_tokens=max_output_tokens)
        return self.parse_response(await self.post_json(http, self.url, self._headers(), body), want_json=False)


def _as_struct(content: str) -> dict[str, Any]:
    """functionResponse.response must be a JSON object."""
    try:
        v = json.loads(content)
    except (TypeError, ValueError):
        return {"result": content}
    return v if isinstance(v, dict) else {"result": v}


__all__ = ["BASE_URL", "GeminiProvider", "to_gemini_schema"]
