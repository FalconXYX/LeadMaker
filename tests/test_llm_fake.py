"""The fake LLM provider: gating, scripts, template output that passes every insights guard."""

from __future__ import annotations

import json
import sys

import pytest

from leadmaker.config import DEFAULT_LLM_MODELS, LLM_PROVIDERS
from leadmaker.insights import OUTPUT_SCHEMA, render_leads_block, validate_item
from leadmaker.llm import (
    ChatMessage, LlmApiError, LlmAuthError, LlmOutputError, LlmQuotaExceeded, LlmRateLimited, get_provider,
)
from leadmaker.llm.providers import REGISTRY
from leadmaker.llm.providers import fake as fake_mod
from leadmaker.llm.providers.fake import FakeProvider, empty_like, parse_leads

from fakes import offline_settings
from test_insights_support import ME_LEAD, fake_settings, lead


def test_registered_by_name_only_never_by_auto():
    assert "fake" in REGISTRY and "fake" in LLM_PROVIDERS and DEFAULT_LLM_MODELS["fake"] == "fake-1"
    assert offline_settings().llm_provider is None  # auto with no keys picks nothing (never the fake)
    p = get_provider(fake_settings())
    assert isinstance(p, FakeProvider) and p.fingerprint == "fake:fake-1"
    assert (p.default_rpm, p.default_rpd) == (0, 0)


def test_gating_allows_pytest_and_the_explicit_flag(monkeypatch):
    p = FakeProvider(fake_settings())
    assert p.is_configured() == (True, "")
    monkeypatch.delitem(sys.modules, "pytest")
    monkeypatch.delenv("LEADMAKER_ALLOW_FAKE_LLM", raising=False)
    ok, why = p.is_configured()
    assert not ok and "LEADMAKER_ALLOW_FAKE_LLM=1" in why
    monkeypatch.setenv("LEADMAKER_ALLOW_FAKE_LLM", "1")
    assert p.is_configured() == (True, "")


async def test_template_output_passes_every_guard_and_records_calls():
    leads = [lead(ME_LEAD, "a"), lead([("business_name", "business_name: Tiny Repairs"),
                                      ("services", "services: Storm damage, Insurance claims")], "b")]
    p = FakeProvider(fake_settings())
    r = await p.generate_json(None, system="sys", user=render_leads_block(leads), schema=OUTPUT_SCHEMA,
                              schema_name="insights")
    items = r.data["insights"]
    assert [i["lead_ref"] for i in items] == ["L1", "L2"]
    assert validate_item(items[0], leads[0]) == [] and validate_item(items[1], leads[1]) == []
    assert "Master Elite" in items[0]["pitch"] and items[0]["product_focus"] == ["architectural_shingles"]
    assert items[0]["target_contact"]["name"] == "Jose Sucuzhanay Sr."
    assert "tarps" in items[1]["pitch"] and items[1]["target_contact"] is None
    assert p.calls == [{"kind": "generate_json", "system": "sys", "user": render_leads_block(leads),
                        "schema_name": "insights"}]
    assert r.usage["input_tokens"] == len(render_leads_block(leads)) // 4 and r.usage["output_tokens"] > 0


@pytest.mark.parametrize("facts, pitch_word, focus", [
    ([("services", "services: Commercial roofing"), ("materials", "materials: TPO roofing")], "TPO", ["tpo_membrane"]),
    ([("account_status", "account_status: lapsed customer")], "win-back", ["architectural_shingles", "underlayment"]),
    ([("services", "services: Roof replacement")], "replacement", ["architectural_shingles", "underlayment"]),
])
async def test_pitch_rules(facts, pitch_word, focus):
    one = lead([("business_name", "business_name: Acme Roofing LLC"), *facts])
    data = (await FakeProvider(fake_settings()).generate_json(
        None, system="", user=render_leads_block([one]), schema=OUTPUT_SCHEMA, schema_name="insights")).data
    item = data["insights"][0]
    assert pitch_word in item["pitch"] and item["product_focus"] == focus
    assert validate_item(item, one) == []


async def test_a_note_with_weather_words_is_not_echoed():
    one = lead([("business_name", "business_name: Acme Roofing LLC"),
                ("note", "note (Jordan L., 2026-10-07): call back tomorrow before the storm")])
    data = (await FakeProvider(fake_settings()).generate_json(
        None, system="", user=render_leads_block([one]), schema=OUTPUT_SCHEMA, schema_name="insights")).data
    assert validate_item(data["insights"][0], one) == []
    assert "tomorrow" not in json.dumps(data)


async def test_script_items_dicts_text_and_errors_then_template():
    p = FakeProvider(fake_settings(), script=[{"insights": []}, '{"insights": [1]}', "not json",
                                              LlmRateLimited("slow", provider="fake")])
    call = lambda: p.generate_json(None, system="", user="", schema=OUTPUT_SCHEMA, schema_name="insights")  # noqa: E731
    assert (await call()).data == {"insights": []}
    assert (await call()).data == {"insights": [1]}
    with pytest.raises(LlmOutputError):
        await call()
    with pytest.raises(LlmRateLimited):
        await call()
    assert (await call()).data == {"insights": []}  # template mode: no <lead> blocks in the message
    assert len(p.calls) == 5


@pytest.mark.parametrize("kind, exc", [("quota", LlmQuotaExceeded), ("rate_limited", LlmRateLimited),
                                       ("auth", LlmAuthError), ("api", LlmApiError), ("output", LlmOutputError)])
async def test_script_file_errors(tmp_path, monkeypatch, kind, exc):
    path = tmp_path / "script.json"
    path.write_text(json.dumps([{"error": kind}, {"text": "ok", "company_ids": []}]))
    monkeypatch.setenv("LEADMAKER_FAKE_LLM_SCRIPT", str(path))
    p = FakeProvider(fake_settings())
    with pytest.raises(exc):
        await p.generate_json(None, system="", user="", schema={}, schema_name="briefing_rewrite")
    if kind == "quota":
        assert p.limiter.remaining_today == 0  # a quota error marks the day as spent, like a real 429
        return
    assert (await p.generate_json(None, system="", user="", schema={}, schema_name="briefing_rewrite")).data == {
        "text": "ok", "company_ids": []}


async def test_briefing_template_echoes_the_digest_text_capped():
    text = "Severe Thunderstorm Warning in Bergen County until 8 PM. " * 10
    data = (await FakeProvider(fake_settings()).generate_json(
        None, system="", user=f"<digest>{{}}</digest>\n<digest_text>{text}</digest_text>", schema={},
        schema_name="briefing_rewrite")).data
    assert data == {"text": text.strip()[:400], "company_ids": []}  # briefing/v3's limit


async def test_chat_and_other_schemas():
    p = FakeProvider(fake_settings())
    r = await p.chat(None, system="", messages=[ChatMessage.user("hi")])
    assert r.text == "fake reply"
    schema = {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": ["integer", "null"]},
                                               "c": {"type": "array", "items": {"type": "string"}}}}
    assert empty_like(schema) == {"a": "", "b": None, "c": []}
    assert (await p.generate_json(None, system="", user="", schema=schema, schema_name="x")).data == empty_like(schema)


def test_parse_leads_reads_keys_and_values():
    block = render_leads_block([lead(ME_LEAD)])
    ((ref, facts),) = parse_leads(block)
    assert ref == "L1" and facts[0] == ("F1", "business_name", "Carework Construction LLC")
    assert facts[-1] == ("F8", "note", "Unhappy with late deliveries from their current supplier")


def test_fake_never_touches_the_usage_file(tmp_path):
    usage = tmp_path / "usage.json"
    p = FakeProvider(fake_settings(llm_usage_file=str(usage), llm_rpd=5))
    assert p.limiter.state_path is None and fake_mod.FakeProvider.default_rpd == 0
