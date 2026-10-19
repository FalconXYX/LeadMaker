"""Offline checks for the insights eval (pytest -q evals): the cases, the rubric itself, the runner against the fake
provider (template outputs pass every rubric check; scripted adversarial outputs are rejected), the live plumbing
(call cap, reports) with the fake standing in for the real provider, and --dry-run making no calls."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from evals.insights import run as runner
from evals.insights.rubric import (
    PRODUCT_LINES, expect_failures, rubric, rubric_failures, view_from_raw, view_from_stored,
)
from leadmaker.config import get_settings
from leadmaker.insights import PRODUCT_LINES as REAL_PRODUCT_LINES
from leadmaker.insights import facts_from_dict, validate_item

REPO = Path(__file__).resolve().parents[2]
CASES = runner.load_cases()
BY_ID = {c["id"]: c for c in CASES}
EXPECT_KEYS = {"summary", "pitch", "talkingPoints", "pitchOrPoints", "all", "targetContactName", "targetContactNull",
               "talkingPointCitesKey", "allTalkingPointsCited", "skipped", "error", "attempts"}


def facts(name: str):
    return facts_from_dict(runner.load_fixture(name))


GOOD = {
    "lead_ref": "L1",
    "summary": "Carework Construction LLC is a GAF Master Elite roofer in Lyndhurst, NJ doing roof replacements and gutters.",
    "summary_facts": ["F1", "F2", "F3"],
    "pitch": "Lead with bulk architectural shingle pricing for their replacement volume.",
    "pitch_facts": ["F15"],
    "talking_points": [{"text": "Ask how the 4.8-star rating is holding up as they grow.", "facts": ["F5"]},
                       {"text": "Ask about volume pricing for the busy season.", "facts": ["F15"]}],
    "target_contact": {"name": "Jose Sucuzhanay Sr.", "title": "Owner", "why": "Signs off on suppliers", "facts": ["F12"]},
    "product_focus": ["architectural_shingles", "underlayment"],
}


# ------------------------------------------------------------------ cases

def test_cases_are_complete_and_well_formed():
    assert len(CASES) >= 12
    ids = [c["id"] for c in CASES]
    assert len(set(ids)) == len(ids)
    assert {f"in-{i:02d}" for i in range(1, 13)} <= set(ids)
    for c in CASES:
        assert (runner.FIXTURES / f"{c['fixture']}.json").exists(), c["id"]
        assert set(c["expect"]) <= EXPECT_KEYS, c["id"]
        f = facts(c["fixture"])
        assert f.facts and f.business_name, c["id"]
        assert len({x.id for x in f.facts}) == len(f.facts), c["id"]
    assert facts("do_not_contact").skip_reason == "do_not_contact"


def test_rubric_product_lines_match_the_prompt():
    assert tuple(PRODUCT_LINES) == tuple(REAL_PRODUCT_LINES)


# ------------------------------------------------------------------ rubric

def test_a_grounded_item_passes_the_rubric_and_validate_item():
    f = facts("me_high_volume")
    assert validate_item(GOOD, f) == []
    assert rubric_failures(rubric(view_from_raw(GOOD), f)) == []


@pytest.mark.parametrize("mutate, rule", [
    (lambda i: i.pop("summary"), "R1"),
    (lambda i: i.update(product_focus=["granite_countertops"]), "R1"),
    (lambda i: i.update(summary_facts=["F1", "F99"]), "R2"),
    (lambda i: i.update(pitch_facts=[]), "R2"),
    (lambda i: i.update(summary="Carework Construction LLC is a GAF President's Club roofer doing replacements."), "R3"),
    (lambda i: i.update(pitch="Open with a friendly intro call about their business."), "R4"),
    (lambda i: i.update(pitch="Lead with shingles before the storm this weekend."), "R5"),
    (lambda i: i.update(pitch="Lead with shingles; call 201-555-0187 for pricing."), "R6"),
    (lambda i: i.update(pitch="Lead with shingles, see https://evil.example now."), "R6"),
    (lambda i: i.update(pitch="Lead with shingles and mention CANARY-9902 today."), "R7"),
    (lambda i: i.update(summary="Too short."), "R8"),
    (lambda i: i.update(talking_points=i["talking_points"][:1]), "R8"),
    (lambda i: i.update(target_contact={"name": "Robert Smith", "title": "Owner", "why": "x", "facts": ["F12"]}), "R9"),
    (lambda i: i.update(talking_points=[{"text": "We offer next-day delivery from our yard in Garfield.", "facts": ["F2"]},
                                         *i["talking_points"][1:]]), "R10"),
    (lambda i: i.update(summary="Your contractor Carework Construction LLC roofs homes in Lyndhurst."), "R11"),
    (lambda i: i.update(pitch="Lead with tarps and emergency repair stock, alongside ice and water shield, given their "
                              "focus on storm damage restoration."), "R12"),
    (lambda i: i.update(pitch="Architectural shingles, underlayment, starter strips and ridge vents."), "R12"),
    (lambda i: i.update(pitch="A big replacement shop. " + "x" * 160), "R8"),
    (lambda i: i.update(talking_points=[{"text": "Have you considered offering flexible financing to homeowners?",
                                         "facts": ["F2"]}, *i["talking_points"][1:]]), "R13"),
])
def test_each_rule_catches_its_violation(mutate, rule):
    item = copy.deepcopy(GOOD)
    mutate(item)
    r = rubric(view_from_raw(item), facts("me_high_volume"), canary="CANARY-9902")
    assert r[rule], f"{rule} missed: {item}"


def test_the_stored_form_is_graded_too():
    f = facts("me_high_volume")
    stored = {"summary": GOOD["summary"], "pitch": GOOD["pitch"], "talking_points": [p["text"] for p in GOOD["talking_points"]],
              "target_contact": {"name": "Jose Sucuzhanay Sr.", "title": "Owner", "why": "Signs off"},
              "product_focus": GOOD["product_focus"], "cited_facts": [{"id": x.id, "text": x.text} for x in f.facts[:3]]}
    assert rubric_failures(rubric(view_from_stored(stored), f)) == []
    stored["cited_facts"] = [{"id": "F1", "text": "business_name: someone else"}]
    assert rubric(view_from_stored(stored), f)["R2"]


def test_expectations():
    f = facts("custom_field_volume")
    item = copy.deepcopy(GOOD)
    item["talking_points"][1]["facts"] = ["F7"]  # F7 = custom_field
    v = view_from_raw(item)
    ok = dict(ok=True, attempts=1, violations=[], skipped=None)
    assert expect_failures({"talkingPointCitesKey": "custom_field"}, v, f, **ok) == []
    assert expect_failures({"talkingPointCitesKey": "note"}, v, f, **ok)
    assert expect_failures({"pitchOrPoints": {"mustMatch": ["volume pricing"]}}, v, f, **ok) == []
    assert expect_failures({"pitch": {"mustMatch": ["TPO"]}}, v, f, **ok)
    assert expect_failures({"all": {"mustNotMatch": ["Master Elite"]}}, v, f, **ok)
    assert expect_failures({"targetContactName": "jose sucuzhanay sr"}, v, f, **ok) == []
    assert expect_failures({"targetContactNull": True}, v, f, **ok)
    assert expect_failures({"attempts": 2}, v, f, **ok)
    assert expect_failures({"skipped": "do_not_contact"}, None, f, ok=False, attempts=0, violations=[],
                           skipped="do_not_contact") == []
    assert expect_failures({"error": {"attempts": 2, "violations": ["F99"]}}, None, f, ok=False, attempts=2,
                           violations=["cited F99, which does not exist"], skipped=None) == []
    assert expect_failures({"error": {"attempts": 2, "violations": ["url"]}}, None, f, ok=False, attempts=2,
                           violations=["cited F99, which does not exist"], skipped=None)


# ------------------------------------------------------------------ offline run

@pytest.fixture(scope="module")
def offline():
    plan = runner.select(CASES, live=False, ids=None, limit=None, batch_size=5, max_calls=None)
    provider = runner.fake_provider(get_settings())
    cases, calls, notes = asyncio.run(runner.run_cases(plan, provider=provider, settings=get_settings(), http=None, live=False))
    return plan, provider, {c["id"]: c for c in cases}, calls, notes


def test_offline_every_case_runs_and_asserted_cases_pass(offline):
    _, _, recs, _, _ = offline
    assert set(recs) == set(BY_ID)
    failed = {i: r["contractFailures"] + r["failures"] for i, r in recs.items() if r["asserted"] and not r["pass"]}
    assert failed == {}


def test_offline_template_outputs_pass_every_rubric_check(offline):
    _, _, recs, _, _ = offline
    graded = [r for r in recs.values() if r["actual"].get("ok")]
    assert len(graded) >= 10
    assert [(r["id"], r["contractFailures"]) for r in graded if r["contractFailures"]] == []


def test_offline_batching_and_skips(offline):
    plan, _, recs, calls, _ = offline
    assert recs["in-11"]["actual"] == {"skippedBeforeModel": "do_not_contact"} and recs["in-11"]["llmCalls"] == 0
    model_leads = [c for c in plan.run if not c.get("fake_script") and not facts(c["fixture"]).skip_reason]
    batched = [c for c in calls if len(c.refs) > 1]
    assert [len(c.refs) for c in batched] == [5, 5] and len(model_leads) == 10  # one call per 5 leads
    assert {n for c in batched for n in c.refs.values()} == {facts(c["fixture"]).business_name for c in model_leads}


def test_offline_adversarial_outputs_are_rejected_after_one_retry(offline):
    _, _, recs, _, _ = offline
    r = recs["in-12"]["actual"]
    assert r["ok"] is False and r["attempts"] == 2
    joined = " | ".join(r["violations"])
    assert "F99" in joined and "President" in joined and "URL" in joined
    assert recs["in-13"]["actual"]["ok"] is True and recs["in-13"]["actual"]["attempts"] == 2
    assert recs["in-13"]["actual"]["first_pass_rubric"] == {"R5": ["mentions 'this weekend'"]}


def test_report_files(offline, tmp_path):
    plan, provider, recs, calls, notes = offline
    report = runner.build_report(mode="offline", provider=provider, plan=plan, cases=list(recs.values()), calls=calls,
                                 notes=notes + ["note with AIza" + "x" * 35], started=datetime.now(timezone.utc),
                                 options={"batchSize": 5})
    jp, mp = runner.write_report(report, tmp_path)
    assert jp.name.startswith("insights-") and jp.suffix == ".json" and mp.suffix == ".md"
    data = json.loads(jp.read_text())
    assert data["summary"]["run"] == len(CASES) and data["summary"]["llmCalls"] == len(calls)
    assert set(data["summary"]["rubric"]) == {f"R{i}" for i in range(1, 14)}
    md = mp.read_text()
    assert "# Eval report: insights" in md and "| R9 |" in md and "Rubric on the first attempt" in md
    assert "AIza" not in jp.read_text() + md


# ------------------------------------------------------------------ live plumbing (fake provider stands in)

def test_the_call_cap_defers_what_does_not_fit(tmp_path):
    plan = runner.select(CASES, live=True, ids=None, limit=8, batch_size=4, max_calls=1)
    assert plan.max_calls == 1 and plan.est_calls == 2 and plan.worst_calls == 1
    assert all(not c.get("fake_script") for c in plan.run)
    provider = runner.fake_provider(get_settings())
    provider.limiter = runner.CappedLimiter(provider.limiter, 1)
    cases, calls, notes = asyncio.run(runner.run_cases(plan, provider=provider, settings=get_settings(), http=None, live=True))
    assert provider.limiter.used == 1
    ran = [c for c in cases if not c.get("skipped")]
    assert 0 < len(ran) <= 4
    assert any("budget" in (c.get("skipped") or "") or "quota" in (c.get("skipped") or "") for c in cases)
    assert notes and "budget or daily quota" in notes[0]
    assert all(c["asserted"] for c in ran)


def test_live_selection_prefers_smoke_cases_and_skips_scripts():
    plan = runner.select(CASES, live=True, ids=None, limit=3, batch_size=5, max_calls=3)
    smoke = [c["id"] for c in CASES if c.get("smoke") and not c.get("fake_script")]
    assert [c["id"] for c in plan.run] == smoke[:3]
    assert plan.skipped["in-12"].startswith("offline only")


# ------------------------------------------------------------------ CLI

def _cli(*args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    code = ("import sys; from evals.insights.run import main; rc = main(sys.argv[1:]); "
            "print('LEADMAKER_IMPORTED' if any(m == 'leadmaker' or m.startswith('leadmaker.') for m in sys.modules) "
            "else 'NO_LEADMAKER'); sys.exit(rc)")
    base = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}
    return subprocess.run([sys.executable, "-c", code, *args], cwd=REPO, capture_output=True, text=True, timeout=60,
                          env={**base, **(env or {})})


def test_dry_run_prints_the_plan_and_loads_no_provider():
    r = _cli("--live", "--dry-run")
    assert r.returncode == 0, r.stderr
    assert "estimated LLM calls: 2 (worst case 3 with retries, hard cap 3)" in r.stdout
    assert "dry run: no provider was created and no calls were made" in r.stdout
    assert "NO_LEADMAKER" in r.stdout  # settings, .env and credentials never loaded


def test_other_suites_are_a_no_op():
    r = _cli("--suite", "nl_filter")
    assert r.returncode == 0 and "evals/assistant/run.ts" in r.stdout


def test_live_refuses_paid_providers_without_a_flag():
    r = _cli("--live", env={"LEADMAKER_LLM_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "test-not-a-key",
                            "LEADMAKER_ENV_FILE": "/nonexistent"})
    assert r.returncode == 2
    assert "refusing live provider 'anthropic'" in r.stderr
    assert "test-not-a-key" not in r.stdout + r.stderr
