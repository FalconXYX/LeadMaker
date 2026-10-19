"""Offline tests for the provider-agnostic llm_extract enricher.

Uses the saved contractor + crawled-page fixtures (llm_extract_*.json, real site text) and recorded-shape
Gemini / Anthropic responses (see tests/test_llm_providers.py for how those fixtures were made). The Gemini
answer deliberately contains an invented owner, the company itself as a "person", a brand that is not on the
site and an invented crew count, so the guards are exercised.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from leadmaker.config import Settings
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.llm_extract import (
    OUTPUT_SCHEMA, PROMPT_VERSION, SERVICES, SERVICE_TO_TAXONOMY, SYSTEM_PROMPT, LlmExtractEnricher, Slot,
    load_slots, output_schema, parse_slots, system_prompt, taxonomy_services,
)
from leadmaker.http import Response
from leadmaker.llm.providers.gemini import GeminiProvider
from leadmaker.llm.ratelimit import RateLimiter, reset_limiters
from leadmaker.models import EnrichmentResult, EnrichmentStatus
from leadmaker.tagging.rules import tag_lead
from leadmaker.tagging.taxonomy import SERVICE_LABELS, STORM_SERVICES

FIX = Path(__file__).parent / "fixtures"
ROOT = Path(__file__).parent.parent
EXAMPLE_SLOTS = ROOT / "examples" / "extraction_slots.example.json"
GID = "1005677"  # American Roofing and Siding


def fx(name: str) -> Any:
    return json.loads((FIX / name).read_text())


def settings(**kw: Any) -> Settings:
    base = dict(gemini_api_key=None, anthropic_api_key=None, llm_provider_setting="auto", llm_model_override=None,
                llm_base_url=None, llm_api_key=None, llm_rpm=0, llm_rpd=0, llm_usage_file="",
                extraction_slots_path=None)
    base.update(kw)
    return Settings(**base)


def ctx(prior_extra: dict[str, EnrichmentResult] | None = None) -> LeadContext:
    contractor = fx("llm_extract_contractors.json")[GID]
    pages = fx("llm_extract_pages_american_roofing.json")["pages"]
    crawl = EnrichmentResult(source="website_crawl", status=EnrichmentStatus.OK, confidence=0.8,
                             data={"pages": pages}, website="https://americanroofingandsiding.com/")
    return LeadContext(contractor=contractor, prior={"website_crawl": crawl, **(prior_extra or {})})


class FakeHttp:
    def __init__(self, *responses: Response):
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def request(self, method: str, url: str, **kw: Any) -> Response:
        self.calls.append({"method": method, "url": url, **kw})
        return self.responses.pop(0)


def gemini_ok() -> Response:
    return Response(url="https://generativelanguage.googleapis.com/", status=200,
                    text=(FIX / "llm_gemini_extract_ok.json").read_text(), headers={})


def gemini_enricher(rpd: int = 0, **kw: Any) -> LlmExtractEnricher:
    s = settings(gemini_api_key="test-key", **kw)
    provider = GeminiProvider(s, limiter=RateLimiter("gemini:test", 0, rpd))
    return LlmExtractEnricher(s, provider=provider)


@pytest.fixture(autouse=True)
def _fresh_limiters():
    reset_limiters()
    yield
    reset_limiters()


# --------------------------------------------------------------------------- enablement


def test_is_enabled_matrix():
    off = LlmExtractEnricher(settings())
    assert off.is_enabled() == (False, "no LLM provider configured (set GEMINI_API_KEY, ANTHROPIC_API_KEY or "
                                       "LEADMAKER_LLM_BASE_URL)")
    on = LlmExtractEnricher(settings(gemini_api_key="g"))
    assert on.is_enabled() == (True, "") and on.provider.name == "gemini"
    bad = LlmExtractEnricher(settings(llm_provider_setting="gpt"))
    assert bad.is_enabled()[0] is False
    forced = LlmExtractEnricher(settings(llm_provider_setting="gemini"))
    assert forced.is_enabled() == (False, "GEMINI_API_KEY (or GOOGLE_API_KEY) not set")
    injected = LlmExtractEnricher(settings(), client=object())  # SDK client injection still works
    assert injected.is_enabled() == (True, "") and injected.provider.name == "anthropic"


# --------------------------------------------------------------------------- end to end (Gemini)


async def test_gemini_extraction_end_to_end_with_guards_and_taxonomy():
    e = gemini_enricher()
    http = FakeHttp(gemini_ok())
    r = await e.enrich(ctx(), http)
    assert r.status == EnrichmentStatus.OK, r.error
    body = http.calls[0]["json"]
    user = body["contents"][0]["parts"][0]["text"]
    assert user.startswith("<contractor_facts>") and "<website_pages>" in user  # data-not-instructions wrapping
    assert body["systemInstruction"]["parts"][0]["text"] == SYSTEM_PROMPT
    assert "custom_slots" not in body["generationConfig"]["responseSchema"]["properties"]

    d = r.data
    assert d["decision_makers"] == [] and r.contacts == []
    assert d["dropped_unverified"] == ["Joe Smith"]  # never written in the input
    assert d["dropped_invalid"] == ["American Roofing"]  # the company, not a person
    assert d["brands_mentioned"] == ["GAF", "Certainteed", "James Hardie"]  # Owens Corning is not on the site
    assert d["llm_services"] == ["roof_replacement", "roof_inspection", "siding", "windows", "gutters",
                                 "new_construction"]
    assert d["services"] == ["gutters", "inspections", "new_construction", "roof_replacement", "shingle_roofing",
                             "siding", "windows"]
    assert d["provider"] == "gemini" and d["model"] == "gemini-3.8-flash" and d["prompt_version"] == PROMPT_VERSION
    assert d["usage"]["input_tokens"] == 9214
    assert "custom_slots" not in d


async def test_llm_services_reach_tagging():
    e = gemini_enricher()
    r = await e.enrich(ctx(), FakeHttp(gemini_ok()))
    lead = {**ctx().contractor, "enrichment": {"llm_extract": {"status": "ok", "data": r.data}}}
    keys = {t["key"] for t in tag_lead(lead)["tags"]}
    assert {"service:inspections", "service:new_construction", "service:gutters"} <= keys
    assert "multi_trade" in keys  # siding + gutters + windows, all from the LLM


def test_every_prompt_label_maps_to_a_known_key():
    assert set(SERVICE_TO_TAXONOMY) == set(SERVICES)
    mapped = set(taxonomy_services(list(SERVICES), []))
    assert {"storm_damage", "insurance_claims", "emergency_service"} == mapped & STORM_SERVICES
    assert {"flat_roofing", "commercial_roofing", "inspections", "general_contracting", "new_construction",
            "chimney", "masonry"} <= mapped & set(SERVICE_LABELS)
    assert set(taxonomy_services([], ["tpo", "slate", "epdm"])) == {
        "tpo_roofing", "single_ply_roofing", "flat_roofing", "slate_roofing"}
    assert "new_construction" in SYSTEM_PROMPT and "new_construction" in json.dumps(OUTPUT_SCHEMA)


# --------------------------------------------------------------------------- custom slots


def test_example_slots_file_is_valid():
    slots = load_slots(str(EXAMPLE_SLOTS))
    assert [s.key for s in slots] == ["offers_solar_installs", "crew_count_estimate", "primary_roof_material"]
    assert [s.type for s in slots] == ["boolean", "number", "enum"]


def test_invalid_slots_are_skipped():
    slots = parse_slots([
        {"key": "ok_slot", "label": "OK", "type": "string"},
        {"key": "Bad Key", "label": "x", "type": "string"},
        {"key": "no_enum", "label": "x", "type": "enum"},
        {"key": "weird", "label": "x", "type": "date"},
        {"key": "ok_slot", "label": "dup", "type": "number"},
        {"key": "str_enum", "label": "x", "type": "enum", "enum": "metal,slate"},  # not a list
        "not an object",
    ])
    assert [s.key for s in slots] == ["ok_slot"]
    assert load_slots("/nonexistent/slots.json") == []
    assert parse_slots({"key": "x"}) == []


def test_slot_schema_and_prompt():
    slots = load_slots(str(EXAMPLE_SLOTS))
    schema = output_schema(slots)
    cs = schema["properties"]["custom_slots"]
    assert schema["required"][-1] == "custom_slots" and cs["required"] == [s.key for s in slots]
    assert cs["properties"]["crew_count_estimate"]["properties"]["value"]["type"] == ["number", "null"]
    assert cs["properties"]["primary_roof_material"]["properties"]["value"]["enum"][-1] is None
    assert output_schema([]) is OUTPUT_SCHEMA and "custom_slots" not in OUTPUT_SCHEMA["properties"]
    prompt = system_prompt(slots)
    assert prompt.startswith(SYSTEM_PROMPT) and "crew_count_estimate (number)" in prompt
    assert "primary_roof_material (one of asphalt_shingles, metal" in prompt


async def test_custom_slots_keep_only_evidenced_typed_answers():
    e = gemini_enricher(extraction_slots_path=str(EXAMPLE_SLOTS))
    http = FakeHttp(gemini_ok())
    r = await e.enrich(ctx(), http)
    assert r.status == EnrichmentStatus.OK, r.error
    sent_schema = http.calls[0]["json"]["generationConfig"]["responseSchema"]
    assert sent_schema["properties"]["custom_slots"]["properties"]["crew_count_estimate"]["properties"]["value"] == {
        "type": "NUMBER", "description": "Number of installation crews", "nullable": True}
    d = r.data
    assert d["custom_slots"] == {
        "offers_solar_installs": None,  # model said null
        "crew_count_estimate": None,  # "Four full-time installation crews." is not on this site -> dropped
        "primary_roof_material": "asphalt_shingles",  # evidence quote found in the roofing page
    }
    assert d["custom_slots_dropped"] == ["crew_count_estimate"]
    assert d["custom_slots_evidence"] == {"primary_roof_material": "Gaf Residential Roofing View Catalog"}


# --------------------------------------------------------------------------- quota + incremental hash


async def test_quota_exhaustion_returns_retryable_skip_and_next_run_retries():
    e = gemini_enricher(rpd=1)
    http = FakeHttp(gemini_ok())
    first = await e.enrich(ctx(), http)
    assert first.status == EnrichmentStatus.OK

    c = ctx()
    stored_hash = e.input_hash(c)  # what the pipeline stores with the quota skip below
    skipped = await e.enrich(c, http)
    assert skipped.status == EnrichmentStatus.SKIPPED and len(http.calls) == 1  # nothing sent
    assert skipped.data["reason"] == "quota" and skipped.data["retry"] is True
    assert skipped.data["provider"] == "gemini" and skipped.data["resets_at"]
    assert "budget of 1" in skipped.data["detail"]

    # Next run: the stored quota skip is inside the TTL, but its hash no longer matches -> re-run.
    c2 = ctx({"llm_extract": skipped})
    assert e.input_hash(c2) != stored_hash
    retry_hash = e.input_hash(c2)
    e2 = gemini_enricher()  # new day / new budget
    ok = await e2.enrich(c2, FakeHttp(gemini_ok()))
    assert ok.status == EnrichmentStatus.OK
    assert ok.data["retried_quota_token"] == skipped.data["quota_token"]
    # The run after that: the OK row reproduces the hash it was stored with -> fresh, no extra call.
    assert e2.input_hash(ctx({"llm_extract": ok})) == retry_hash
    # TTL refresh (30 days later): stored with the hash computed from the OK row; the new OK row must
    # reproduce it too, or the lead would be re-run once more for nothing.
    c3 = ctx({"llm_extract": ok})
    refresh_hash = e2.input_hash(c3)
    refreshed = await e2.enrich(c3, FakeHttp(gemini_ok()))
    assert refreshed.data["retried_quota_token"] == skipped.data["quota_token"]
    assert e2.input_hash(ctx({"llm_extract": refreshed})) == refresh_hash


def test_input_hash_changes_with_prompt_model_provider_and_slots(monkeypatch, tmp_path):
    c = ctx()
    base = gemini_enricher().input_hash(c)
    assert gemini_enricher().input_hash(c) == base  # deterministic

    other_model = LlmExtractEnricher(settings(gemini_api_key="g", llm_model_override="gemini-3.8-flash"))
    assert other_model.input_hash(c) != base
    other_provider = LlmExtractEnricher(settings(anthropic_api_key="a"))
    assert other_provider.input_hash(c) != base

    slots = tmp_path / "slots.json"
    slots.write_text(EXAMPLE_SLOTS.read_text())
    with_slots = gemini_enricher(extraction_slots_path=str(slots))
    assert with_slots.input_hash(c) != base
    edited = json.loads(slots.read_text())
    edited[0]["description"] += " Include solar attic fans."
    slots.write_text(json.dumps(edited))
    assert gemini_enricher(extraction_slots_path=str(slots)).input_hash(c) != with_slots.input_hash(c)

    monkeypatch.setattr("leadmaker.enrich.llm_extract.PROMPT_VERSION", "llm_extract/v999")
    assert gemini_enricher().input_hash(c) != base


def test_input_hash_tracks_prompt_facts_but_not_review_counts():
    e = gemini_enricher()
    c = ctx()
    base = e.input_hash(c)
    bumped = LeadContext(contractor={**c.contractor, "review_count": 999, "rating": 4.1}, prior=c.prior)
    assert e.input_hash(bumped) == base
    new_desc = LeadContext(contractor={**c.contractor, "description": "Now also commercial roofing."}, prior=c.prior)
    assert e.input_hash(new_desc) != base


async def test_auth_error_is_recorded_as_error():
    e = gemini_enricher()
    bad = Response(url="https://generativelanguage.googleapis.com/", status=400,
                   text=(FIX / "llm_gemini_error_invalid_key_400.json").read_text(), headers={})
    r = await e.enrich(ctx(), FakeHttp(bad))
    assert r.status == EnrichmentStatus.ERROR and "API_KEY_INVALID" in r.error


async def test_no_website_text_is_skipped_without_a_call():
    e = gemini_enricher()
    http = FakeHttp()
    c = LeadContext(contractor=fx("llm_extract_contractors.json")[GID])
    r = await e.enrich(c, http)
    assert r.status == EnrichmentStatus.SKIPPED and r.data == {"reason": "no website text"} and http.calls == []


# --------------------------------------------------------------------------- Anthropic batch path


def test_batch_request_uses_anthropic_params_even_on_gemini():
    e = gemini_enricher(extraction_slots_path=str(EXAMPLE_SLOTS))
    req = e.batch_request(ctx())
    assert req["custom_id"] == GID
    p = req["params"]
    assert p["model"] == "claude-haiku-5-5" and p["max_tokens"] == 16000
    assert p["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert p["output_config"]["format"]["schema"]["properties"]["custom_slots"]
    assert p["messages"][0]["content"].startswith("<contractor_facts>")


def test_result_from_batch_message_runs_the_same_guard():
    e = LlmExtractEnricher(settings(anthropic_api_key="a"), client=object())
    r = e.result_from_message(ctx(), fx("llm_anthropic_extract_ok.json"))
    assert r.status == EnrichmentStatus.OK
    assert r.data["provider"] == "anthropic" and r.data["model"] == "claude-haiku-5-5"
    assert r.data["dropped_unverified"] == ["Joe Smith"]
    assert r.data["usage"]["cache_read_input_tokens"] == 4410
    refusal = {"model": "claude-haiku-5-5", "content": [], "stop_reason": "refusal", "stop_details": None}
    assert e.result_from_message(ctx(), refusal).status == EnrichmentStatus.ERROR


def test_slot_dataclass_round_trip():
    s = Slot(key="k", label="L", type="enum", enum=("a",))
    assert s.as_dict() == {"key": "k", "label": "L", "type": "enum", "description": "", "enum": ["a"]}
    assert replace(s, label="M").label == "M"
