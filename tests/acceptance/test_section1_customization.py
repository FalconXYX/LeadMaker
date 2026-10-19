"""Section 1 acceptance -- User-Guided Customization (and Custom User Tagging).

Requirements (docs/OpeningRequirements.MD, Section 1):
  "Reps can create custom tags and information slots. Slots are also passed into the pipeline to guide
   LLM extraction and insight generation; this is experimental and will be dropped if it doesn't work well."
  "Custom User Tagging: Supports rep-created tags and custom key-value data slots so the team can adapt
   categorization as business needs evolve."
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from leadmaker.custom_tags import RuleError
from leadmaker.enrich.llm_extract import load_slots
from leadmaker.http import Response
from leadmaker.models import Contractor, ContractorProfile, EnrichmentResult, EnrichmentStatus
from leadmaker.pipeline import enrich as enrich_mod
from leadmaker.pipeline.enrich import EnrichOptions, run_enrich
from leadmaker.pipeline.tag import run_tagging

from dbutil import cid, enrichments_by_gaf, leads_by_gaf
from fakes import EXAMPLES, FIX, RoutedHttp, offline_settings, seed_area


SLOTS_FILE = EXAMPLES / "extraction_slots.example.json"
LLM_GID = "1005677"  # American Roofing and Siding (real contractor + crawled pages fixtures)


def _tags(repo):
    return {r["gaf_id"]: ({t["key"]: t for t in r["tags"]}, r["priority_score"]) for r in repo.get_companies()}


def _write(tmp_path: Path, rules) -> Path:
    p = tmp_path / "rules.json"
    p.write_text(json.dumps(rules))
    return p


def test_custom_json_rules_add_explained_tags_and_shift_priority(repo, tmp_path):
    """'Reps can create custom tags': a JSON rules file adds tags (with label, reason and source) to the
    matching leads only, and each rule's priority_boost moves exactly those leads' scores."""
    cs = seed_area(repo)
    base = run_tagging(repo, "10013", 25)
    before = _tags(repo)
    assert base["custom_rules"] == 0

    rules = _write(tmp_path, [
        {"key": "nj_push", "label": "NJ territory push", "reason": "Q4 NJ expansion", "priority_boost": 7,
         "when": {"field": "state", "eq": "NJ"}},
        {"key": "unreviewed", "label": "No reviews yet", "priority_boost": -5,
         "when": {"all": [{"field": "review_count", "lte": 0}, {"not": {"field": "tier", "eq": "master_elite"}}]}},
        {"key": "queens", "label": "Queens", "when": {"field": "city", "in": ["Flushing", "Jamaica"]}},
        {"key": "says_roofing", "label": "Roofing in name", "when": {"text_contains": ["ROOFING"]}},
    ])
    out = run_tagging(repo, "10013", 25, rules_path=rules)
    after = _tags(repo)

    assert out["custom_rules"] == 4
    nj = {c.gaf_id for c in cs if c.state == "NJ"}
    unreviewed = {c.gaf_id for c in cs if c.review_count == 0 and c.tier.value != "master_elite"}
    assert nj and unreviewed
    for c in cs:
        tags, prio = after[c.gaf_id]
        old_prio = before[c.gaf_id][1]
        boost = (7 if c.gaf_id in nj else 0) + (-5 if c.gaf_id in unreviewed else 0)
        assert prio == pytest.approx(max(0.0, min(100.0, old_prio + boost)))
        assert ("nj_push" in tags) == (c.gaf_id in nj)
        assert ("unreviewed" in tags) == (c.gaf_id in unreviewed)
    gid_nj = next(iter(nj))
    tag = after[gid_nj][0]["nj_push"]
    assert tag == {"key": "nj_push", "value": True, "label": "NJ territory push", "category": "custom",
                   "reason": "Q4 NJ expansion", "source": "custom_rule"}
    assert {g for g, (t, _) in after.items() if "queens" in t} == {c.gaf_id for c in cs if c.city in ("Flushing", "Jamaica")}
    # text_contains is case-insensitive over the text held about the lead (here: the business names).
    assert {g for g, (t, _) in after.items() if "says_roofing" in t} == {c.gaf_id for c in cs if "roofing" in c.name.lower()}

    # The change is audited against the tagging run that made it.
    ev = [e for e in repo.audit_log(gaf_id=gid_nj, run_id=out["run_id"]) if e["entity_type"] == "tags"]
    assert ev and "nj_push=True" in ev[0]["changes"]["tags_added"][1]

    # Rules can also come from $LEADMAKER_TAG_RULES; removing a rule removes its tag on the next run.
    rules.write_text(json.dumps([{"key": "queens", "label": "Queens", "when": {"field": "city", "eq": "Flushing"}}]))
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("LEADMAKER_TAG_RULES", str(rules))
        run_tagging(repo, "10013", 25)
    assert "nj_push" not in _tags(repo)[gid_nj][0]
    assert _tags(repo)[gid_nj][1] == pytest.approx(before[gid_nj][1])


def test_malformed_rules_file_is_rejected_before_any_lead_changes(repo, tmp_path):
    """A rule the system cannot evaluate is refused up front instead of silently tagging nothing."""
    seed_area(repo)
    run_tagging(repo, "10013", 25)
    before = _tags(repo)
    bad = _write(tmp_path, [{"key": "x", "when": {"field": "state", "approximately": "NJ"}}])
    with pytest.raises(RuleError):
        run_tagging(repo, "10013", 25, rules_path=bad)
    assert _tags(repo) == before


# ------------------------------------------------------------------- extraction slots (LLM)
def _seed_llm_lead(repo) -> None:
    raw = json.loads((FIX / "llm_extract_contractors.json").read_text())[LLM_GID]
    c = Contractor(**{k: v for k, v in raw.items() if k in Contractor.model_fields and v is not None})
    seed_area(repo, [c], postal_code="10013", radius=25)
    repo.save_profile(cid(repo, LLM_GID), ContractorProfile(gaf_id=LLM_GID, legal_name=raw["legal_name"],
                                                            description=raw["description"]))
    pages = json.loads((FIX / "llm_extract_pages_american_roofing.json").read_text())["pages"]
    repo.save_enrichment(cid(repo, LLM_GID), EnrichmentResult(
        source="website_crawl", status=EnrichmentStatus.OK, confidence=0.8, data={"pages": pages},
        website="https://americanroofingandsiding.com/", source_urls=[p["url"] for p in pages[:3]]))


def _gemini() -> RoutedHttp:
    ok = (FIX / "llm_gemini_extract_ok.json").read_text()
    return RoutedHttp([("https://generativelanguage.googleapis.com/",
                        lambda m, u, kw: Response(url=u, status=200, text=ok, headers={}))])


def _schemas(http: RoutedHttp) -> list[dict]:
    return [c["json"]["generationConfig"]["responseSchema"] for c in http.calls]


async def test_extraction_slots_extend_the_llm_schema_and_rerun_only_affected_extractions(repo, monkeypatch):
    """'Slots are also passed into the pipeline to guide LLM extraction': adding a slots file changes the
    schema sent to the model and the extraction's input hash, so the stored extraction re-runs inside its
    TTL and stores a typed value per slot; without a change, the next run makes no LLM call."""
    _seed_llm_lead(repo)
    http = _gemini()
    monkeypatch.setattr(enrich_mod, "HttpClient", http)
    opts = EnrichOptions(gaf_ids=[LLM_GID], sources=["llm_extract"])
    plain = offline_settings(gemini_api_key="test-key")

    r1 = await run_enrich(plain, repo, opts)
    assert r1.stats["by_source"]["llm_extract"] == {"ok": 1}
    assert "custom_slots" not in _schemas(http)[0]["properties"]
    row1 = enrichments_by_gaf(repo, [LLM_GID])[LLM_GID]["llm_extract"]
    assert row1["status"] == "ok" and "custom_slots" not in row1["data"] and row1["input_hash"]
    assert row1["data"]["summary"] and row1["data"]["provider"] == "gemini"  # the pipeline's AI summary

    r2 = await run_enrich(plain, repo, opts)  # nothing changed -> fresh, no request
    assert r2.stats["by_source"]["llm_extract"] == {"fresh": 1} and len(http.calls) == 1

    slotted = offline_settings(gemini_api_key="test-key", extraction_slots_path=str(SLOTS_FILE))
    r3 = await run_enrich(slotted, repo, opts)
    assert r3.stats["by_source"]["llm_extract"] == {"input_changed": 1, "ok": 1}
    keys = [s.key for s in load_slots(str(SLOTS_FILE))]
    sent = _schemas(http)[1]["properties"]["custom_slots"]
    assert sorted(sent["properties"]) == sorted(keys)
    row3 = enrichments_by_gaf(repo, [LLM_GID])[LLM_GID]["llm_extract"]
    assert row3["input_hash"] != row1["input_hash"]
    assert set(row3["data"]["custom_slots"]) == set(keys)
    assert row3["data"]["custom_slots"]["primary_roof_material"] == "asphalt_shingles"  # evidenced answer
    upd = [e for e in repo.audit_log(gaf_id=LLM_GID, run_id=r3.run_id) if e["entity_type"] == "enrichment"]
    assert upd and "custom_slots" in upd[0]["changes"]["data_keys_changed"][1]

    r4 = await run_enrich(slotted, repo, opts)  # same slots again -> fresh
    assert r4.stats["by_source"]["llm_extract"] == {"fresh": 1} and len(http.calls) == 2


async def test_slot_values_can_drive_custom_tags(repo, monkeypatch, tmp_path):
    """'custom key-value data slots so the team can adapt categorization': a rule can read an extracted
    slot value (dotted path into the enrichment) and tag the lead from it."""
    _seed_llm_lead(repo)
    monkeypatch.setattr(enrich_mod, "HttpClient", _gemini())
    slotted = offline_settings(gemini_api_key="test-key", extraction_slots_path=str(SLOTS_FILE))
    await run_enrich(slotted, repo, EnrichOptions(gaf_ids=[LLM_GID], sources=["llm_extract"]))
    rules = _write(tmp_path, [{
        "key": "shingle_shop", "label": "Shingle-first roofer", "priority_boost": 3,
        "reason": "LLM slot primary_roof_material = asphalt_shingles",
        "when": {"field": "enrichment.llm_extract.data.custom_slots.primary_roof_material", "eq": "asphalt_shingles"},
    }])
    run_tagging(repo, "10013", 25, rules_path=rules)
    tags = {t["key"]: t for t in leads_by_gaf(repo, [LLM_GID])[0]["tags"]}
    assert tags["shingle_shop"]["source"] == "custom_rule"
    assert tags["shingle_shop"]["reason"] == "LLM slot primary_roof_material = asphalt_shingles"
