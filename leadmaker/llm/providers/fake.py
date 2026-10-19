"""Deterministic fake LLM provider for tests, evals and offline demos (no network, no key, no cost).

Two modes, per call:
  * script: `FakeProvider(settings, script=[...])`, or a JSON list in $LEADMAKER_FAKE_LLM_SCRIPT, is consumed one
    item per call: a dict is returned as `data`, a str is raw model text (parsed like a real answer, so invalid
    JSON raises LlmOutputError), and an LlmError instance (or {"error": "quota"|"rate_limited"|"auth"|"api"|
    "output"}) is raised.
  * template (once the script is used up): answers built from the prompt itself, so a pipeline run with
    LEADMAKER_LLM_PROVIDER=fake writes valid rows. `insights` reads each <lead>'s numbered facts and obeys every
    leadmaker.insights guard; `briefing_rewrite` returns the <digest_text> verbatim; any other schema gets an
    empty object of the right shape.

Gating: usable only under pytest or with LEADMAKER_ALLOW_FAKE_LLM=1, and only when named explicitly
(LEADMAKER_LLM_PROVIDER=fake); "auto" never picks it. It has its own unlimited, unpersisted rate limiter unless
one is passed, so it never touches data/llm_usage.json.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Sequence

from ...http import HttpClient
from ..base import (
    ChatMessage, LlmApiError, LlmAuthError, LlmError, LlmOutputError, LlmProvider, LlmQuotaExceeded,
    LlmRateLimited, LlmResponse, ToolSpec, parse_json_object,
)
from ..ratelimit import RateLimiter

ERROR_KINDS = ("quota", "rate_limited", "auth", "api", "output")
_LEAD = re.compile(r'<lead ref="([^"]+)">(.*?)</lead>', re.S)
_FACTS = re.compile(r"<facts>\n?(.*?)</facts>", re.S)
_FACT = re.compile(r"^(F\d+) ([a-z_]+)(?: \(([^)]*)\))?: (.*)$")
_DIGEST_TEXT = re.compile(r"<digest_text>(.*?)</digest_text>", re.S)


def allowed() -> bool:
    return os.environ.get("LEADMAKER_ALLOW_FAKE_LLM", "").strip() == "1" or "pytest" in sys.modules


def script_error(kind: str, resets_at: Any = None) -> LlmError:
    """The typed error a script entry {"error": kind} stands for."""
    msg = f"fake provider: scripted {kind} error"
    if kind == "quota":
        return LlmQuotaExceeded(msg, provider="fake", status=429, resets_at=resets_at)
    if kind == "rate_limited":
        return LlmRateLimited(msg, provider="fake", retry_after=1.0)
    if kind == "auth":
        return LlmAuthError(msg, provider="fake", status=401)
    if kind == "output":
        return LlmOutputError(msg, provider="fake")
    return LlmApiError(msg, provider="fake", status=500)


def load_script(path: str | Path) -> list[Any]:
    items = json.loads(Path(path).read_text())
    if not isinstance(items, list):
        raise ValueError(f"{path}: a fake LLM script must be a JSON list")
    return items


class FakeProvider(LlmProvider):
    name = "fake"
    default_rpm = 0
    default_rpd = 0

    def __init__(self, settings, *, model: str | None = None, limiter: RateLimiter | None = None,
                 script: Sequence[Any] | None = None):
        super().__init__(settings, model=model, limiter=limiter or RateLimiter(f"{self.name}:{model or 'fake-1'}"))
        if script is None and (path := os.environ.get("LEADMAKER_FAKE_LLM_SCRIPT")):
            script = load_script(path)
        self.script: list[Any] = list(script or [])
        self.calls: list[dict[str, Any]] = []

    def is_configured(self) -> tuple[bool, str]:
        if allowed():
            return True, ""
        return False, "fake provider is for tests; set LEADMAKER_ALLOW_FAKE_LLM=1"

    def _next(self) -> Any:
        """The next scripted item (an error is raised), or None in template mode."""
        if not self.script:
            return None
        item = self.script.pop(0)
        if isinstance(item, dict) and set(item) == {"error"} and item["error"] in ERROR_KINDS:
            item = script_error(item["error"], self.limiter.resets_at())
        if isinstance(item, LlmError):
            if isinstance(item, LlmQuotaExceeded):
                self.limiter.mark_exhausted()
            raise item
        return item

    async def generate_json(self, http: HttpClient, *, system: str, user: str, schema: dict[str, Any],
                            max_output_tokens: int = 8000, schema_name: str = "output") -> LlmResponse:
        self.calls.append({"kind": "generate_json", "system": system, "user": user, "schema_name": schema_name})
        await self.limiter.acquire()
        item = self._next()
        if isinstance(item, str):
            data = parse_json_object(item, self.name)
        elif isinstance(item, dict):
            data = item
        elif schema_name == "insights":
            data = template_insights(user)
        elif schema_name == "briefing_rewrite":
            data = template_briefing(user)
        else:
            data = empty_like(schema)
        out = json.dumps(data, ensure_ascii=False)
        return LlmResponse(provider=self.name, model=self.model, text=out, data=data, stop_reason="STOP",
                           usage={"input_tokens": len(user) // 4, "output_tokens": len(out) // 4})

    async def chat(self, http: HttpClient, *, system: str, messages: Sequence[ChatMessage],
                   tools: Sequence[ToolSpec] = (), tool_choice: str = "auto",
                   max_output_tokens: int = 4096) -> LlmResponse:
        self.calls.append({"kind": "chat", "system": system, "user": messages[-1].content if messages else "",
                           "schema_name": None})
        await self.limiter.acquire()
        item = self._next()
        text = item if isinstance(item, str) else "fake reply"
        return LlmResponse(provider=self.name, model=self.model, text=text, stop_reason="STOP",
                           usage={"input_tokens": sum(len(m.content) for m in messages) // 4,
                                  "output_tokens": len(text) // 4})


# --------------------------------------------------------------------------- template mode


def parse_leads(user: str) -> list[tuple[str, list[tuple[str, str, str]]]]:
    """[(ref, [(fact id, key, value)])] from an insights user message (render_leads_block)."""
    out = []
    for ref, body in _LEAD.findall(user):
        m = _FACTS.search(body)
        facts = []
        for line in (m.group(1) if m else "").splitlines():
            fm = _FACT.match(line.strip())
            if fm:
                facts.append((fm.group(1), fm.group(2), fm.group(4).strip()))
        out.append((ref, facts))
    return out


def _cap(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    cut = text[: n - 1].rsplit(" ", 1)[0].rstrip(" ,;:")
    return cut + "…"


def _clean_point(text: str, fact_texts: list[str]) -> bool:
    """True when a talking point built from lead data passes the insights text guards (lazy import: the
    insights package imports this layer)."""
    from ...insights.validate import text_problems

    return not text_problems(text, fact_texts)


def template_item(ref: str, facts: list[tuple[str, str, str]]) -> dict[str, Any]:
    first: dict[str, tuple[str, str]] = {}
    for fid, key, value in facts:
        first.setdefault(key, (fid, value))
    fact_texts = [f"{k}: {v}" for _, k, v in facts]

    def fid(key: str) -> str | None:
        return first[key][0] if key in first else None

    def val(key: str) -> str:
        return first[key][1] if key in first else ""

    name = val("business_name") or "This contractor"
    summary_facts = [f for f in (fid("business_name"), fid("location")) if f]
    summary = f"{name} is a roofing contractor in {val('location')}." if val("location") else \
        f"{name} is a roofing contractor."
    if val("services"):
        room = 280 - len(summary) - len(" They list .")
        if room >= 20:
            summary += f" They list {_cap(val('services'), room).rstrip('…').rstrip(' ,')}."
            summary_facts.append(fid("services"))
    if len(summary) < 20:
        summary = f"{name} is a roofing contractor in this territory."
    summary = _cap(summary, 280)

    work = f"{val('services')} {val('work_types')}".lower()
    mats = f"{val('materials')} {val('services')}".lower()
    if re.search(r"storm|insurance|emergency", work):
        src = fid("work_types") if re.search(r"storm|insurance|emergency", val("work_types").lower()) else fid("services")
        pitch, pitch_facts, focus = ("Lead with emergency tarps and repair stock for their storm-restoration work.",
                                     [src], ["tarps_emergency_repair"])
    elif re.search(r"tpo|flat|commercial", mats):
        src = fid("materials") if re.search(r"tpo|flat|commercial", val("materials").lower()) else fid("services")
        pitch, pitch_facts, focus = ("Lead with TPO membrane and flat-roof accessories for their commercial work.",
                                     [src], ["tpo_membrane"])
    elif "master elite" in val("gaf_tier").lower():
        pitch, pitch_facts, focus = ("Lead with bulk architectural shingle pricing for a high-volume Master Elite shop.",
                                     [fid("gaf_tier")], ["architectural_shingles"])
    elif "lapsed" in val("account_status").lower():
        pitch, pitch_facts, focus = ("Open with a win-back offer on architectural shingles and underlayment.",
                                     [fid("account_status")], ["architectural_shingles", "underlayment"])
    else:
        pitch, pitch_facts, focus = ("Lead with architectural shingles and underlayment for their replacement work.",
                                     [fid("services") or fid("business_name") or facts[0][0]],
                                     ["architectural_shingles", "underlayment"])

    points: list[dict[str, Any]] = []
    stars = re.match(r"([\d.]+) stars?", val("rating"))
    if stars:
        points.append({"text": f"Ask how their {stars.group(1)}-star rating is holding up as they grow.",
                       "facts": [fid("rating")]})
    else:
        points.append({"text": "Ask what work they do most.", "facts": [fid("business_name") or facts[0][0]]})
    note = next(((f, v) for f, k, v in facts if k == "note"), None)
    second = None
    if note:
        candidate = f"Follow up on the last note: {_cap(note[1], 80).rstrip('.…')}."
        if _clean_point(candidate, fact_texts):
            second = {"text": candidate, "facts": [note[0]]}
    if second is None and val("services"):
        second = {"text": f"Ask which of their services ({_cap(val('services'), 70).rstrip('…').rstrip(' ,')}) is growing fastest.",
                  "facts": [fid("services")]}
    if second is None and val("location"):
        second = {"text": "Ask which towns around their base keep their crews busiest.", "facts": [fid("location")]}
    if second is None:
        second = {"text": "Ask who handles their material orders.", "facts": [fid("business_name") or facts[0][0]]}
    points.append(second)

    target = None
    tc = val("target_contact")
    if "—" in tc:
        role, _, rest = tc.partition("—")
        person = rest.strip().split(", ", 1)[0].strip()
        if person:
            target = {"name": person, "title": role.strip(), "why": f"Named as the {role.strip().lower()} to ask for.",
                      "facts": [fid("target_contact")]}
    return {
        "lead_ref": ref, "summary": summary, "summary_facts": [f for f in summary_facts if f] or [facts[0][0]],
        "pitch": pitch, "pitch_facts": pitch_facts, "talking_points": points, "target_contact": target,
        "product_focus": focus,
    }


def template_insights(user: str) -> dict[str, Any]:
    return {"insights": [template_item(ref, facts) for ref, facts in parse_leads(user) if facts]}


def template_briefing(user: str) -> dict[str, Any]:
    m = _DIGEST_TEXT.search(user)
    text = (m.group(1).strip() if m else "")[:400]  # briefing/v3's rewrite limit
    return {"text": text, "company_ids": []}


def empty_like(schema: dict[str, Any]) -> Any:
    """The emptiest value matching a JSON schema (objects with every property, nulls where allowed)."""
    if "anyOf" in schema:
        variants = schema["anyOf"]
        if any(v.get("type") == "null" for v in variants):
            return None
        return empty_like(variants[0])
    typ = schema.get("type")
    if isinstance(typ, list):
        if "null" in typ:
            return None
        typ = typ[0]
    if typ == "object":
        return {k: empty_like(v) for k, v in (schema.get("properties") or {}).items()}
    if typ == "array":
        return []
    if typ == "string":
        return (schema.get("enum") or [""])[0]
    if typ in ("number", "integer"):
        return 0
    if typ == "boolean":
        return False
    return None


__all__ = ["ERROR_KINDS", "FakeProvider", "allowed", "empty_like", "load_script", "parse_leads", "script_error",
           "template_insights"]
