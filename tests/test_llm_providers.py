"""Offline tests for the LLM providers (no API keys, no network).

Fixtures: `llm_gemini_error_invalid_key_400.json` and `..._unregistered_403.json` are real responses
captured from generativelanguage.googleapis.com (bogus key / no key, Oct 2026). The success, function-call
and 429 payloads are hand-built to the documented generateContent / google.rpc (QuotaFailure, RetryInfo)
JSON shapes, and the Anthropic messages to the Messages API shape, because no key was available.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

import pytest

from leadmaker.config import Settings
from leadmaker.http import HttpError, Response
from leadmaker.llm import (
    ChatMessage, LlmAuthError, LlmOutputError, LlmQuotaExceeded, LlmRateLimited, ToolSpec, get_provider,
)
from leadmaker.llm.providers.anthropic import AnthropicProvider
from leadmaker.llm.providers.gemini import GeminiProvider, to_gemini_schema
from leadmaker.llm.providers.openai_compat import OpenAICompatProvider
from leadmaker.llm.ratelimit import RateLimiter, reset_limiters

FIX = Path(__file__).parent / "fixtures"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"


def fx(name: str) -> dict[str, Any]:
    return json.loads((FIX / f"llm_{name}.json").read_text())


def settings(**kw: Any) -> Settings:
    base = dict(gemini_api_key=None, anthropic_api_key=None, llm_provider_setting="auto", llm_model_override=None,
                llm_base_url=None, llm_api_key=None, llm_rpm=0, llm_rpd=0, llm_usage_file="")
    base.update(kw)
    return Settings(**base)


def resp(status: int, body: Any, headers: dict[str, str] | None = None) -> Response:
    text = body if isinstance(body, str) else json.dumps(body)
    return Response(url=GEMINI_URL, status=status, text=text, headers=headers or {"content-type": "application/json"})


class FakeHttp:
    """Mimics HttpClient.request: returns the scripted responses in order (statuses are allowed by caller)."""

    def __init__(self, *responses: Response | Exception | Callable[[dict[str, Any]], Response]):
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def request(self, method: str, url: str, **kw: Any) -> Response:
        self.calls.append({"method": method, "url": url, **kw})
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r(kw) if callable(r) else r


@pytest.fixture(autouse=True)
def _fresh_limiters():
    reset_limiters()
    yield
    reset_limiters()


def gemini(**kw: Any) -> tuple[GeminiProvider, list[float]]:
    """A Gemini provider whose retry sleeps and rate-limiter waits run on a virtual clock (recorded)."""
    slept: list[float] = []
    now = [0.0]

    async def fake_sleep(s: float) -> None:
        slept.append(round(s, 3))
        now[0] += s

    s = settings(gemini_api_key="test-key", **kw)
    lim = RateLimiter("gemini:gemini-3.8-flash", s.llm_rpm or 0, s.llm_rpd or 0, clock=lambda: now[0],
                      sleep=fake_sleep)
    p = GeminiProvider(s, limiter=lim)
    p._sleep = fake_sleep
    return p, slept


SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string", "enum": ["a", "b"]}},
        "crews": {"type": ["number", "null"], "description": "crew count"},
        "pick": {"type": ["string", "null"], "enum": ["x", "y", None]},
        "size": {"type": "object", "properties": {"range": {"type": "string"}}, "required": ["range"],
                 "additionalProperties": False},
    },
    "required": ["name", "tags", "crews", "pick", "size"],
    "additionalProperties": False,
}


# --------------------------------------------------------------------------- provider selection


def test_auto_selection_prefers_gemini_then_anthropic_then_base_url():
    assert settings().llm_provider is None
    assert get_provider(settings()) is None
    assert settings(anthropic_api_key="a").llm_provider == "anthropic"
    s = settings(anthropic_api_key="a", gemini_api_key="g")
    assert s.llm_provider == "gemini" and s.llm_model == "gemini-3.5-flash-lite"
    assert settings(anthropic_api_key="a").llm_model == "claude-haiku-5-5"
    assert settings(llm_base_url="http://localhost:11434/v1").llm_provider == "openai_compat"
    forced = settings(gemini_api_key="g", llm_provider_setting="anthropic", llm_model_override="claude-sonnet-5-5")
    assert forced.llm_provider == "anthropic" and forced.llm_model == "claude-sonnet-5-5"
    with pytest.raises(ValueError):
        _ = settings(llm_provider_setting="openai").llm_provider


def test_model_override_applies_only_to_the_active_provider():
    s = settings(gemini_api_key="g", llm_model_override="gemini-3.5-flash-lite")
    assert GeminiProvider(s).model == "gemini-3.5-flash-lite"
    assert AnthropicProvider(s).model == "claude-haiku-5-5"  # batch path keeps its own default


def test_free_tier_defaults_are_conservative_and_env_overridable():
    p = GeminiProvider(Settings(gemini_api_key="g", llm_rpm=None, llm_rpd=None, llm_usage_file=""))
    assert (p.limiter.rpm, p.limiter.rpd) == (5, 200)
    p = GeminiProvider(Settings(gemini_api_key="g", llm_rpm=15, llm_rpd=1000, llm_usage_file=""))
    assert (p.limiter.rpm, p.limiter.rpd) == (15, 1000)
    a = AnthropicProvider(Settings(anthropic_api_key="a", llm_rpm=None, llm_rpd=None, llm_usage_file=""))
    assert (a.limiter.rpm, a.limiter.rpd) == (0, 0)


def test_is_configured_reasons():
    assert GeminiProvider(settings()).is_configured() == (False, "GEMINI_API_KEY (or GOOGLE_API_KEY) not set")
    assert AnthropicProvider(settings()).is_configured()[0] is False
    assert AnthropicProvider(settings(), client=object()).is_configured() == (True, "")
    oc = OpenAICompatProvider(settings(llm_provider_setting="openai_compat"))
    assert oc.is_configured()[0] is False  # needs LEADMAKER_LLM_MODEL


# --------------------------------------------------------------------------- Gemini


def test_gemini_schema_conversion():
    g = to_gemini_schema(SCHEMA)
    assert g["type"] == "OBJECT" and "additionalProperties" not in g
    assert g["propertyOrdering"] == ["name", "tags", "crews", "pick", "size"]
    assert g["properties"]["tags"] == {"type": "ARRAY", "items": {"type": "STRING", "enum": ["a", "b"]}}
    assert g["properties"]["crews"] == {"type": "NUMBER", "description": "crew count", "nullable": True}
    assert g["properties"]["pick"] == {"type": "STRING", "enum": ["x", "y"], "nullable": True}
    assert g["properties"]["size"]["required"] == ["range"]
    assert "additionalProperties" not in json.dumps(g)
    anyof = to_gemini_schema({"anyOf": [{"type": "integer"}, {"type": "null"}]})
    assert anyof == {"type": "INTEGER", "nullable": True}


async def test_gemini_generate_json_request_and_parse():
    p, _ = gemini()
    http = FakeHttp(resp(200, fx("gemini_extract_ok")))
    r = await p.generate_json(http, system="SYS", user="USER", schema=SCHEMA, max_output_tokens=1234)
    call = http.calls[0]
    assert call["url"] == GEMINI_URL and call["method"] == "POST"
    assert call["headers"]["x-goog-api-key"] == "test-key" and "key=" not in call["url"]
    assert call["retries"] == 0 and 429 in call["allow_statuses"]
    body = call["json"]
    assert body["systemInstruction"] == {"parts": [{"text": "SYS"}]}
    assert body["contents"] == [{"role": "user", "parts": [{"text": "USER"}]}]
    cfg = body["generationConfig"]
    assert cfg["responseMimeType"] == "application/json" and cfg["maxOutputTokens"] == 1234
    assert cfg["responseSchema"]["type"] == "OBJECT"
    assert r.provider == "gemini" and r.model == "gemini-3.8-flash"  # the fixture's modelVersion
    assert r.data["residential_commercial_mix"] == "residential_only"
    assert r.usage == {"input_tokens": 9214, "output_tokens": 431, "thinking_tokens": 570}


async def test_gemini_function_call_parsing_and_thought_signature_replay():
    p, _ = gemini()
    tool = ToolSpec("applyListFilters", "Apply filters to the lead list.", {
        "type": "object", "properties": {"tiers": {"type": "array", "items": {"type": "string"}},
                                         "max_distance_miles": {"type": ["number", "null"]}},
        "required": ["tiers"], "additionalProperties": False})
    http = FakeHttp(resp(200, fx("gemini_function_call")), resp(200, fx("gemini_extract_ok")))
    history = [ChatMessage.user("Show me storm roofers near me")]
    r = await p.chat(http, system="You filter leads.", messages=history, tools=[tool])
    body = http.calls[0]["json"]
    decl = body["tools"][0]["functionDeclarations"][0]
    assert decl["name"] == "applyListFilters" and decl["parameters"]["type"] == "OBJECT"
    assert body["toolConfig"] == {"functionCallingConfig": {"mode": "AUTO"}}
    assert r.text.startswith("Filtering to Master Elite")
    [call] = r.tool_calls
    assert call.name == "applyListFilters"
    assert call.arguments == {"tiers": ["master_elite"], "services": ["storm_damage"], "max_distance_miles": 10}

    history += [r.message, ChatMessage.tool_result(call, {"matched": 12})]
    await p.chat(http, system="You filter leads.", messages=history, tools=[tool])
    contents = http.calls[1]["json"]["contents"]
    assert [c["role"] for c in contents] == ["user", "model", "user"]
    # The model turn is replayed verbatim, thought signature included.
    assert contents[1]["parts"][1]["thoughtSignature"] == "CiQBVKhc7cFixtureSignatureOnlyForTests0000AAAA=="
    fr = contents[2]["parts"][0]["functionResponse"]
    assert fr["name"] == "applyListFilters" and fr["response"] == {"matched": 12}
    assert "id" not in fr  # the API returned no call id, so none is invented on the wire


async def test_gemini_tool_choice_modes():
    p, _ = gemini()
    tool = ToolSpec("t", "d", {"type": "object", "properties": {}})
    body = p.chat_body(system="", messages=[ChatMessage.user("x")], tools=[tool], tool_choice="t", max_output_tokens=10)
    assert body["toolConfig"] == {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["t"]}}
    assert "systemInstruction" not in body


async def test_gemini_real_invalid_key_is_fatal_without_retry():
    p, slept = gemini()
    http = FakeHttp(resp(400, fx("gemini_error_invalid_key_400")))
    with pytest.raises(LlmAuthError, match="API_KEY_INVALID"):
        await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    with pytest.raises(LlmAuthError):  # remembered: no second request
        await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    assert len(http.calls) == 1 and slept == []


async def test_gemini_real_unregistered_caller_403():
    p, _ = gemini()
    with pytest.raises(LlmAuthError, match="PERMISSION_DENIED"):
        await p.generate_json(FakeHttp(resp(403, fx("gemini_error_unregistered_403"))), system="s", user="u",
                              schema=SCHEMA)


async def test_gemini_failed_precondition_is_fatal():
    # Shape of Google's 400 for unsupported regions / free tier unavailable (hand-built from the documented text).
    p, slept = gemini()
    body = {"error": {"code": 400, "message": "User location is not supported for the API use.",
                      "status": "FAILED_PRECONDITION"}}
    http = FakeHttp(resp(400, body))
    with pytest.raises(LlmAuthError, match="FAILED_PRECONDITION"):
        await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    with pytest.raises(LlmAuthError):  # the rest of the run fails fast instead of spending budget
        await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    assert len(http.calls) == 1 and slept == []


def test_gemini_base_url_override_needs_explicit_provider():
    # auto mode: LEADMAKER_LLM_BASE_URL is for openai_compat; the Gemini key must not go there.
    auto = GeminiProvider(settings(gemini_api_key="g", llm_base_url="https://openrouter.ai/api/v1"))
    assert auto.url == GEMINI_URL
    explicit = GeminiProvider(settings(gemini_api_key="g", llm_provider_setting="gemini",
                                       llm_base_url="https://proxy.example/v1beta/"))
    assert explicit.url == "https://proxy.example/v1beta/models/gemini-3.5-flash-lite:generateContent"


async def test_gemini_per_minute_429_honours_retry_delay_then_succeeds():
    p, slept = gemini()
    http = FakeHttp(resp(429, fx("gemini_error_rate_minute_429")), resp(200, fx("gemini_extract_ok")))
    r = await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    assert r.data is not None and len(http.calls) == 2
    assert slept == [7.0]  # RetryInfo.retryDelay "7s"


async def test_gemini_per_day_429_marks_quota_exhausted():
    p, slept = gemini()
    http = FakeHttp(resp(429, fx("gemini_error_quota_day_429")))
    with pytest.raises(LlmQuotaExceeded) as ei:
        await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    assert "PerDay" in str(ei.value) and ei.value.resets_at is not None
    assert slept == [] and p.limiter.remaining_today == 0
    with pytest.raises(LlmQuotaExceeded):  # refused client-side, nothing sent
        await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    assert len(http.calls) == 1


async def test_gemini_client_budget_exhaustion_sends_nothing():
    p, _ = gemini(llm_rpd=1)
    http = FakeHttp(resp(200, fx("gemini_extract_ok")))
    await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    with pytest.raises(LlmQuotaExceeded, match="budget of 1"):
        await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    assert len(http.calls) == 1


async def test_gemini_429_without_details_uses_retry_after_header_and_gives_up():
    p, slept = gemini()
    r429 = resp(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "slow down"}},
                headers={"Retry-After": "3"})
    http = FakeHttp(r429, r429, r429, r429)
    with pytest.raises(LlmRateLimited):
        await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    assert len(http.calls) == 4 and slept == [3.0, 3.0, 3.0]


async def test_gemini_long_retry_delay_gives_up_immediately():
    p, slept = gemini()
    body = fx("gemini_error_rate_minute_429")
    body["error"]["details"][1]["retryDelay"] = "600s"
    with pytest.raises(LlmRateLimited):
        await p.generate_json(FakeHttp(resp(429, body)), system="s", user="u", schema=SCHEMA)
    assert slept == []


async def test_gemini_5xx_and_network_errors_are_retried():
    p, slept = gemini()
    http = FakeHttp(resp(503, {"error": {"code": 503, "status": "UNAVAILABLE", "message": "overloaded"}}),
                    HttpError("network error"), resp(200, fx("gemini_extract_ok")))
    r = await p.generate_json(http, system="s", user="u", schema=SCHEMA)
    assert r.data is not None and len(slept) == 2


@pytest.mark.parametrize("payload, match", [
    ({"candidates": [{"content": {"parts": [{"text": "{\"a\""}]}, "finishReason": "MAX_TOKENS"}]}, "truncated"),
    ({"candidates": [{"content": {"parts": []}, "finishReason": "SAFETY"}]}, "SAFETY"),
    ({"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}}, "prompt blocked"),
    ({"candidates": [{"content": {"parts": [{"text": "not json"}]}, "finishReason": "STOP"}]}, "invalid JSON"),
])
async def test_gemini_unusable_answers(payload, match):
    p, _ = gemini()
    with pytest.raises(LlmOutputError, match=match):
        await p.generate_json(FakeHttp(resp(200, payload)), system="s", user="u", schema=SCHEMA)


async def test_gemini_skips_thought_parts():
    p, _ = gemini()
    payload = {"candidates": [{"content": {"parts": [{"text": "thinking...", "thought": True}, {"text": "{\"x\": 1}"}]},
                               "finishReason": "STOP"}]}
    r = await p.generate_json(FakeHttp(resp(200, payload)), system="s", user="u", schema=SCHEMA)
    assert r.data == {"x": 1}


# --------------------------------------------------------------------------- Anthropic (SDK client faked)


class FakeMessages:
    def __init__(self, *results: Any):
        self.results = list(results)
        self.calls: list[dict[str, Any]] = []

    async def create(self, **params: Any) -> Any:
        self.calls.append(params)
        r = self.results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


class FakeClient:
    def __init__(self, *results: Any):
        self.messages = FakeMessages(*results)


class FakeApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status_code = status
        self.message = message
        self.request_id = "req_fixture"


async def test_anthropic_generate_json_params_and_parse():
    client = FakeClient(fx("anthropic_extract_ok"))
    p = AnthropicProvider(settings(anthropic_api_key="a"), client=client)
    r = await p.generate_json(None, system="SYS", user="USER", schema=SCHEMA, max_output_tokens=900)
    params = client.messages.calls[0]
    assert params["model"] == "claude-haiku-5-5" and params["max_tokens"] == 900
    assert params["system"] == [{"type": "text", "text": "SYS", "cache_control": {"type": "ephemeral"}}]
    assert params["output_config"] == {"format": {"type": "json_schema", "schema": SCHEMA}}
    assert r.data["summary"].startswith("American Roofing") and r.model == "claude-haiku-5-5"
    assert r.usage["cache_read_input_tokens"] == 4410


async def test_anthropic_tool_use_round_trip_keeps_thinking_blocks():
    client = FakeClient(fx("anthropic_tool_use"), fx("anthropic_extract_ok"))
    p = AnthropicProvider(settings(anthropic_api_key="a"), client=client)
    tool = ToolSpec("applyListFilters", "Apply filters.", {"type": "object", "properties": {}})
    history = [ChatMessage.user("storm roofers near me")]
    r = await p.chat(None, system="S", messages=history, tools=[tool])
    assert client.messages.calls[0]["tools"] == [
        {"name": "applyListFilters", "description": "Apply filters.", "input_schema": {"type": "object", "properties": {}}}]
    assert client.messages.calls[0]["tool_choice"] == {"type": "auto"}
    [call] = r.tool_calls
    assert call.id == "toolu_01Fixture" and call.arguments["max_distance_miles"] == 10
    history += [r.message, ChatMessage.tool_result(call, {"matched": 12}),
                ChatMessage.tool_result(call, "second result", is_error=True)]
    await p.chat(None, system="S", messages=history, tools=[tool])
    msgs = client.messages.calls[1]["messages"]
    assert msgs[1]["content"][0]["type"] == "thinking"  # replayed verbatim
    assert [b["type"] for b in msgs[2]["content"]] == ["tool_result", "tool_result"]  # one user turn
    assert msgs[2]["content"][0] == {"type": "tool_result", "tool_use_id": "toolu_01Fixture", "content": '{"matched": 12}'}
    assert msgs[2]["content"][1]["is_error"] is True


async def test_anthropic_refusal_and_error_mapping():
    refusal = {"model": "claude-haiku-5-5", "content": [], "stop_reason": "refusal",
               "stop_details": {"type": "refusal", "category": "cyber"}}
    p = AnthropicProvider(settings(anthropic_api_key="a"), client=FakeClient(refusal))
    with pytest.raises(LlmOutputError, match="category=cyber"):
        await p.generate_json(None, system="s", user="u", schema=SCHEMA)

    p = AnthropicProvider(settings(anthropic_api_key="a"), client=FakeClient(FakeApiError(429, "rate limited")))
    with pytest.raises(LlmRateLimited, match="429"):
        await p.generate_json(None, system="s", user="u", schema=SCHEMA)

    credit = FakeApiError(400, "Your credit balance is too low to access the Anthropic API.")
    client = FakeClient(credit)
    p = AnthropicProvider(settings(anthropic_api_key="a"), client=client)
    with pytest.raises(LlmQuotaExceeded) as ei:
        await p.generate_json(None, system="s", user="u", schema=SCHEMA)
    assert ei.value.scope == "billing"
    with pytest.raises(LlmQuotaExceeded):  # fail fast: no second request
        await p.generate_json(None, system="s", user="u", schema=SCHEMA)
    assert len(client.messages.calls) == 1


# --------------------------------------------------------------------------- OpenAI-compatible


async def test_openai_compat_json_and_tool_calls():
    p = OpenAICompatProvider(settings(llm_provider_setting="openai_compat", llm_model_override="qwen3:8b",
                                      llm_api_key="sk-local"))
    ok = {"model": "qwen3:8b", "choices": [{"finish_reason": "stop", "message": {"role": "assistant",
                                                                                 "content": "{\"x\": 1}"}}],
          "usage": {"prompt_tokens": 10, "completion_tokens": 3}}
    tool = {"model": "qwen3:8b", "choices": [{"finish_reason": "tool_calls", "message": {
        "role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {
            "name": "applyListFilters", "arguments": "{\"tiers\": [\"master_elite\"]}"}}]}}]}
    http = FakeHttp(resp(200, ok), resp(200, tool))
    r = await p.generate_json(http, system="S", user="U", schema=SCHEMA)
    call = http.calls[0]
    assert call["url"] == "http://localhost:11434/v1/chat/completions"
    assert call["headers"]["Authorization"] == "Bearer sk-local"
    assert call["json"]["response_format"]["json_schema"]["schema"] == SCHEMA
    assert r.data == {"x": 1} and r.usage == {"input_tokens": 10, "output_tokens": 3}
    r = await p.chat(http, system="S", messages=[ChatMessage.user("hi")],
                     tools=[ToolSpec("applyListFilters", "d", {"type": "object", "properties": {}})])
    assert r.tool_calls[0].arguments == {"tiers": ["master_elite"]}
    assert http.calls[1]["json"]["tools"][0]["function"]["name"] == "applyListFilters"


async def test_gemini_auth_failure_stops_leads_already_waiting_for_a_slot():
    import asyncio

    now = [0.0]

    async def yielding_sleep(sec: float) -> None:
        now[0] += sec
        await asyncio.sleep(0)

    class YieldingHttp(FakeHttp):
        async def request(self, method: str, url: str, **kw: Any) -> Response:
            await asyncio.sleep(0)  # in flight: other leads reach the limiter meanwhile
            return await super().request(method, url, **kw)

    s = settings(gemini_api_key="test-key")
    p = GeminiProvider(s, limiter=RateLimiter("gemini:x", 60, 0, clock=lambda: now[0], sleep=yielding_sleep))
    http = YieldingHttp(resp(400, fx("gemini_error_invalid_key_400")), resp(200, fx("gemini_extract_ok")),
                        resp(200, fx("gemini_extract_ok")))
    results = await asyncio.gather(*(p.generate_json(http, system="s", user="u", schema=SCHEMA) for _ in range(3)),
                                   return_exceptions=True)
    assert all(isinstance(r, LlmAuthError) for r in results), results
    assert len(http.calls) == 1
    assert p.limiter.used_today == 1  # the aborted waiters did not consume budget
