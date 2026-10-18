"""Provider-agnostic LLM interface.

Two calls cover everything the product needs:
  * `generate_json(system, user, schema)` -> one JSON object that matches a JSON schema
    (pipeline extraction now; summaries and pitches later);
  * `chat(system, messages, tools)` -> assistant text and/or tool calls (the Section 4 assistant:
    profile Q&A and the `applyListFilters` tool).

Providers translate these into their own wire format (leadmaker.llm.providers). Messages and tool
calls use small neutral dataclasses; an assistant turn keeps the provider's raw content in
`ChatMessage.raw`, so a tool loop can replay it verbatim (Gemini thought signatures and Claude
thinking blocks must be sent back unchanged on the next turn).

Errors are typed so callers can react without parsing strings:
  LlmQuotaExceeded  daily budget / free-tier quota / credit balance spent -> stop for today, retry later
  LlmRateLimited    still throttled after the allowed retries -> transient, retry next run
  LlmAuthError      bad key, API not enabled, unknown model, region/billing not allowed -> every further
                    call would fail too
  LlmOutputError    refusal, safety block, truncation, invalid JSON -> this request is unusable
  LlmApiError       anything else (5xx after retries, network)
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, ClassVar, Sequence

from ..config import Settings
from ..http import HttpClient, HttpError, Response

if TYPE_CHECKING:
    from .ratelimit import RateLimiter

log = logging.getLogger(__name__)

LLM_REQUEST_TIMEOUT_S = 120.0  # one generateContent / chat call; thinking models can take a while
MAX_ATTEMPTS = 4  # per call, for 429 (per-minute) / 408 / 5xx / network errors
MAX_RETRY_WAIT_S = 90.0  # a longer Retry-After gives up (the pipeline's per-lead timeout is 180 s)
ERROR_STATUSES = tuple(range(400, 600))  # returned by HttpClient, not raised: we classify them here


# --------------------------------------------------------------------------- errors


class LlmError(Exception):
    def __init__(self, message: str, *, provider: str = "", status: int | None = None):
        super().__init__(message)
        self.provider = provider
        self.status = status


class LlmQuotaExceeded(LlmError):
    def __init__(self, message: str, *, provider: str = "", status: int | None = None,
                 resets_at: datetime | None = None, scope: str = "daily"):
        super().__init__(message, provider=provider, status=status)
        self.resets_at = resets_at
        self.scope = scope  # "daily" (client budget or provider RPD) | "billing" (credit balance)


class LlmRateLimited(LlmError):
    def __init__(self, message: str, *, provider: str = "", status: int | None = 429,
                 retry_after: float | None = None):
        super().__init__(message, provider=provider, status=status)
        self.retry_after = retry_after


class LlmAuthError(LlmError):
    """Key missing/invalid, API disabled, permission denied, unknown model or region/billing not allowed."""


class LlmOutputError(LlmError):
    """The model answered but the answer is unusable (refusal, blocked, truncated, invalid JSON)."""


class LlmApiError(LlmError):
    """Other HTTP or network failure (after retries)."""


# --------------------------------------------------------------------------- messages


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON schema of the arguments object


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass
class ChatMessage:
    role: str  # "user" | "assistant" | "tool"
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)  # assistant turns
    tool_call_id: str | None = None  # tool results
    name: str | None = None  # tool results: the tool's name (Gemini needs it)
    is_error: bool = False  # tool results
    raw: dict[str, Any] | None = None  # assistant turns: {"provider": ..., <native content>}

    @classmethod
    def user(cls, text: str) -> "ChatMessage":
        return cls(role="user", content=text)

    @classmethod
    def tool_result(cls, call: ToolCall, content: Any, *, is_error: bool = False) -> "ChatMessage":
        text = content if isinstance(content, str) else json.dumps(content, default=str)
        return cls(role="tool", content=text, tool_call_id=call.id, name=call.name, is_error=is_error)


@dataclass
class LlmResponse:
    provider: str
    model: str
    text: str = ""
    data: dict[str, Any] | None = None  # generate_json: the parsed object
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop_reason: str | None = None
    usage: dict[str, int] = field(default_factory=dict)
    raw_content: Any = None  # provider-native assistant content (replayed by the same provider)

    @property
    def message(self) -> ChatMessage:
        """This response as an assistant turn to append to the conversation."""
        raw = {"provider": self.provider, "content": self.raw_content} if self.raw_content is not None else None
        return ChatMessage(role="assistant", content=self.text, tool_calls=list(self.tool_calls), raw=raw)


def parse_json_object(raw: str, provider: str = "") -> dict[str, Any]:
    """Parse a model's JSON answer (tolerating a ```json fence)."""
    raw = (raw or "").strip()
    if not raw:
        raise LlmOutputError("no JSON output in response", provider=provider)
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    try:
        payload = json.loads(raw)
    except ValueError as e:
        raise LlmOutputError(f"invalid JSON from model: {e}", provider=provider) from e
    if not isinstance(payload, dict):
        raise LlmOutputError("model output is not a JSON object", provider=provider)
    return payload


def retry_after_seconds(headers: dict[str, str]) -> float | None:
    for k, v in headers.items():
        if k.lower() == "retry-after":
            try:
                return max(0.0, float(v))
            except ValueError:
                return None  # HTTP-date form: let the caller fall back to its own backoff
    return None


# --------------------------------------------------------------------------- providers


class LlmProvider(ABC):
    name: ClassVar[str]
    # Client-side defaults when LEADMAKER_LLM_RPM / _RPD are unset (0 = unlimited).
    default_rpm: ClassVar[int] = 0
    default_rpd: ClassVar[int] = 0

    def __init__(self, settings: Settings, *, model: str | None = None, limiter: "RateLimiter | None" = None):
        from ..config import DEFAULT_LLM_MODELS
        from .ratelimit import get_limiter

        self.settings = settings
        if model:
            self.model = model
        elif settings.llm_provider == self.name and settings.llm_model_override:
            self.model = settings.llm_model_override
        else:
            self.model = DEFAULT_LLM_MODELS.get(self.name, "")
        rpm = settings.llm_rpm if settings.llm_rpm is not None else self.default_rpm
        rpd = settings.llm_rpd if settings.llm_rpd is not None else self.default_rpd
        self.limiter = limiter or get_limiter(f"{self.name}:{self.model}", rpm, rpd, settings.llm_usage_file)
        self._fatal: LlmError | None = None  # auth / unknown-model failure: fail fast for the rest of the run
        self._sleep = asyncio.sleep

    @property
    def fingerprint(self) -> str:
        return f"{self.name}:{self.model}"

    def is_configured(self) -> tuple[bool, str]:
        """(usable, reason-if-not)."""
        return True, ""

    @abstractmethod
    async def generate_json(
        self, http: HttpClient, *, system: str, user: str, schema: dict[str, Any],
        max_output_tokens: int = 8000, schema_name: str = "output",
    ) -> LlmResponse:
        """One JSON object matching `schema` (response.data)."""

    @abstractmethod
    async def chat(
        self, http: HttpClient, *, system: str, messages: Sequence[ChatMessage],
        tools: Sequence[ToolSpec] = (), tool_choice: str = "auto", max_output_tokens: int = 4096,
    ) -> LlmResponse:
        """Assistant text and/or tool calls. tool_choice: "auto" | "none" | "required" | a tool name."""

    # -- shared HTTP path for REST providers (Gemini, OpenAI-compatible) -------
    def classify_error(self, resp: Response) -> LlmError:
        """Map an error response to a typed error. Providers override for vendor details."""
        msg = f"HTTP {resp.status}: {(resp.text or '')[:300]}"
        if resp.status == 429:
            return LlmRateLimited(msg, provider=self.name, retry_after=retry_after_seconds(resp.headers))
        if resp.status in (401, 403, 404):
            return LlmAuthError(msg, provider=self.name, status=resp.status)
        return LlmApiError(msg, provider=self.name, status=resp.status)

    async def post_json(self, http: HttpClient, url: str, headers: dict[str, str], body: dict[str, Any]) -> Any:
        """POST with client-side rate limiting, typed errors and 429/5xx backoff (honours Retry-After)."""
        if self._fatal is not None:
            raise self._fatal
        last: LlmError | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            await self.limiter.acquire(abort=lambda: self._fatal)  # another lead may fail auth meanwhile
            try:
                resp = await http.request("POST", url, headers=headers, json=body, retries=0,
                                          allow_statuses=ERROR_STATUSES, timeout=LLM_REQUEST_TIMEOUT_S)
            except HttpError as e:  # network-level failure
                last = LlmApiError(str(e), provider=self.name)
                delay = None
            else:
                if resp.ok:
                    try:
                        return resp.json()
                    except ValueError as e:
                        raise LlmApiError(f"non-JSON response: {e}", provider=self.name, status=resp.status) from e
                err = self.classify_error(resp)
                if isinstance(err, LlmQuotaExceeded):
                    self.limiter.mark_exhausted()
                    raise err
                if isinstance(err, LlmAuthError):
                    self._fatal = err
                    raise err
                retryable = isinstance(err, LlmRateLimited) or resp.status in (408, 409) or resp.status >= 500
                if not retryable:
                    raise err
                last = err
                delay = err.retry_after if isinstance(err, LlmRateLimited) else retry_after_seconds(resp.headers)
                if delay is not None and delay > MAX_RETRY_WAIT_S:
                    raise err
                if isinstance(err, LlmRateLimited):
                    # Throttled: push the shared limiter's next slot out, so every caller waits, not just us.
                    if attempt < MAX_ATTEMPTS:
                        self.limiter.backoff(delay if delay is not None else min(60.0, 5.0 * 2**attempt))
                    continue
            if attempt == MAX_ATTEMPTS:
                break
            wait = delay if delay is not None else min(30.0, 2.0 * 2**attempt) + random.uniform(0, 1)
            log.debug("%s: retry %d/%d in %.1fs (%s)", self.name, attempt, MAX_ATTEMPTS - 1, wait, last)
            await self._sleep(wait)
        assert last is not None
        raise last


# --------------------------------------------------------------------------- schema helpers


def strict_object(properties: dict[str, Any], description: str | None = None) -> dict[str, Any]:
    """An object schema with every property required and no extras (what strict modes want)."""
    out: dict[str, Any] = {
        "type": "object", "properties": properties, "required": list(properties), "additionalProperties": False,
    }
    if description:
        out["description"] = description
    return out


__all__ = [
    "ChatMessage", "LlmApiError", "LlmAuthError", "LlmError", "LlmOutputError", "LlmProvider",
    "LlmQuotaExceeded", "LlmRateLimited", "LlmResponse", "ToolCall", "ToolSpec", "parse_json_object",
    "retry_after_seconds", "strict_object",
]
