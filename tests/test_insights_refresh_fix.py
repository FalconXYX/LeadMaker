"""Refresh fix (2026-10-19): a profile Refresh with a new tag and note must land, not time out.

* salvage: an answer whose problems are local to a sentence or a talking point loses those parts and is kept when the
  rest passes every guard (no retry spent); it is still rejected when too little would remain;
* the distributor guard lets a hedged first-person offer through ("we could check", "we may be able to") and still
  fails a flat promise ("we stock", "we can deliver", "with our metal stock");
* a manual (rep-requested) run gets 3 model attempts per lead, a batch run 2;
* an error row emits lead.updated ['insights'] (the store and run tests cover the event itself).
"""

from __future__ import annotations

import pytest

from leadmaker.insights import InsightsOptions, generate, run_insights, validate_item
from leadmaker.insights.generate import BATCH_ATTEMPTS, MANUAL_ATTEMPTS
from leadmaker.insights.validate import salvage_item, text_problems
from leadmaker.llm.ratelimit import reset_limiters

from dbutil import add_user
from test_insights_support import ME_LEAD, fake, fake_settings, insight_events, insight_rows, lead, seeded, valid_item

ME = lead(ME_LEAD)
METAL = ["custom_tag: Metal roofing specialist",
         "note (Rep One, 2026-10-19): Owner said they're moving into standing-seam metal and want a second supplier"]
PROMISE = "We stock standing-seam metal panels and deliver next day."


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    for k in ("LEADMAKER_INSIGHTS_BATCH_SIZE", "LEADMAKER_INSIGHTS_MAX_ATTEMPTS", "LEADMAKER_FAKE_LLM_SCRIPT",
              "LEADMAKER_MANUAL_INSIGHTS_PER_DAY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("LEADMAKER_INSIGHTS_CONCURRENCY", "1")
    reset_limiters()
    yield
    reset_limiters()


def points(*texts: str) -> list[dict]:
    return [{"text": t, "facts": ["F5"]} for t in texts]


# --------------------------------------------------------------------------- the distributor guard


@pytest.mark.parametrize("text", [
    "We can check our standing-seam metal stock for their next job.",
    "We could check whether our metal inventory covers a second-supplier role.",
    "We may be able to offer volume pricing on standing-seam panels as their second supplier.",
    "Happy to see if our stock of standing-seam coil fits their crews.",
    "Ask whether they'd consider our metal stock as a backup to their current supplier.",
    "Offer to check our metal stock for their standing-seam jobs.",
])
def test_a_hedged_first_person_offer_passes(text):
    assert text_problems(text, METAL) == []


@pytest.mark.parametrize("text", [
    PROMISE,
    "We offer volume pricing on standing-seam panels.",
    "We can deliver standing-seam panels to their jobs next day.",
    "We will have their metal panels on the truck.",
    "Our yard carries standing-seam coil in every gauge.",
    "Position us as their second supplier with our metal stock.",
    "Check lead times, since our metal stock ships same day.",
    "We could cover them, since our trucks run to Emerson daily.",
])
def test_a_flat_promise_still_fails(text):
    assert any("speaks for the distributor" in p for p in text_problems(text, METAL)), text


# --------------------------------------------------------------------------- salvage


def test_salvage_drops_an_offending_talking_point_and_keeps_the_rest():
    item = valid_item(talking_points=points("Ask how the 4.8-star rating is holding up as they add crews.",
                                            PROMISE,
                                            "Follow up on the late deliveries from their current supplier."))
    assert any("speaks for the distributor" in p for p in validate_item(item, ME))
    fixed, dropped = salvage_item(item, ME)
    assert dropped == ["talking point 2"] and validate_item(fixed, ME) == []
    assert [p["text"] for p in fixed["talking_points"]] == [item["talking_points"][0]["text"],
                                                            item["talking_points"][2]["text"]]
    assert len(item["talking_points"]) == 3  # the input is not mutated


def test_salvage_drops_an_offending_pitch_sentence():
    pitch = ("Lead with bulk architectural shingles for this high-volume Master Elite replacement shop. "
             "We stock every color they run and deliver next day. "
             "Ask who handles their material takeoffs on multi-structure reroofs.")
    fixed, dropped = salvage_item(valid_item(pitch=pitch), ME)
    assert dropped == ["1 pitch sentence(s)"] and validate_item(fixed, ME) == []
    assert "We stock" not in fixed["pitch"] and fixed["pitch"].startswith("Lead with bulk architectural shingles")


def test_salvage_drops_a_pitch_sentence_that_lists_products():
    # Live 2026-10-19 (Allied Roofing Solutions): 2 of 3 manual attempts failed only on this one pitch sentence.
    pitch = ("Lead with bulk architectural shingles for this high-volume Master Elite replacement shop. "
             "They need a distributor for shingles, siding, gutters, and TPO membrane on every job. "
             "Ask who handles their material takeoffs on multi-structure reroofs.")
    item = valid_item(pitch=pitch)
    assert any("strings products together" in p for p in validate_item(item, ME))
    fixed, dropped = salvage_item(item, ME)
    assert dropped == ["1 pitch sentence(s)"] and validate_item(fixed, ME) == []
    assert "TPO membrane" not in fixed["pitch"] and fixed["pitch"].endswith("multi-structure reroofs.")


def test_salvage_drops_a_repeated_opening():
    item = valid_item(talking_points=points("Since they do storm work, ask how their tarp supply holds up.",
                                            "Since they are Master Elite, ask who supplies their shingles.",
                                            "Follow up on the late deliveries from their current supplier."))
    fixed, dropped = salvage_item(item, ME)
    assert dropped == ["talking point 2"] and validate_item(fixed, ME) == []


def test_salvage_rejects_when_too_little_remains():
    # one talking point left (2 needed)
    assert salvage_item(valid_item(talking_points=points(PROMISE, "Ask how the 4.8-star rating is holding up.")),
                        ME)[0] is None
    # fewer than half the pitch's sentences left
    pitch = ("Lead with bulk architectural shingles for their replacement jobs. We stock every color they run. "
             "We deliver next day from our yard.")
    assert salvage_item(valid_item(pitch=pitch), ME)[0] is None
    # a structural problem is never salvaged
    assert salvage_item(valid_item(pitch_facts=["F99"]), ME) == (None, [])
    # nothing to drop: not a salvage
    assert salvage_item(valid_item(), ME) == (None, [])


async def test_generate_keeps_a_salvaged_answer_without_a_retry():
    p = fake([{"insights": [valid_item(talking_points=points(
        "Ask how the 4.8-star rating is holding up as they add crews.", PROMISE,
        "Follow up on the late deliveries from their current supplier."))]}])
    stats: dict = {}
    (r,) = await generate(p, None, [ME], stats=stats)
    assert r.ok and r.attempts == 1 and stats["llm_calls"] == 1 and len(p.calls) == 1
    assert PROMISE not in r.insight["talking_points"] and len(r.insight["talking_points"]) == 2


# --------------------------------------------------------------------------- attempts


BAD = {"insights": [{"lead_ref": "L1", "summary": "x", "summary_facts": ["F99"], "pitch": "y", "pitch_facts": [],
                     "talking_points": [], "target_contact": None, "product_focus": []}]}


async def test_generate_attempts_per_lead():
    assert (BATCH_ATTEMPTS, MANUAL_ATTEMPTS) == (2, 3)
    p = fake([BAD, BAD, BAD])
    (r,) = await generate(p, None, [ME], model_attempts=MANUAL_ATTEMPTS)
    assert not r.ok and r.attempts == 3 and len(p.calls) == 3
    # each retry carries the latest problems as feedback
    assert all("Your previous answer had problems" in c["user"] for c in p.calls[1:])
    p = fake([BAD, BAD, BAD])
    (r,) = await generate(p, None, [ME])
    assert not r.ok and r.attempts == 2 and len(p.calls) == 2
    p = fake([BAD])
    (r,) = await generate(p, None, [ME], model_attempts=1)
    assert not r.ok and r.attempts == 1 and "cited F99, which does not exist" in r.violations


async def test_a_manual_refresh_gets_a_third_attempt_and_a_batch_run_does_not(repo):
    ids = seeded(repo)
    rep = add_user(repo, "Rep One")
    manual = InsightsOptions.from_params({"company_ids": [ids[0]], "force": True, "requested_by": rep})
    out = await run_insights(fake_settings(), repo, manual, provider=fake([BAD, BAD]))  # 3rd call: a valid answer
    assert out["generated"] == 1 and out["errors"] == 0 and out["llm_calls"] == 3
    (row,) = insight_rows(repo, ids[0])
    assert row["status"] == "ok"
    out = await run_insights(fake_settings(), repo, InsightsOptions(company_ids=[ids[1]]), provider=fake([BAD, BAD]))
    assert out["errors"] == 1 and out["llm_calls"] == 2


async def test_a_failed_manual_refresh_writes_an_error_row_and_emits_the_event(repo):
    ids = seeded(repo)
    rep = add_user(repo, "Rep One")
    manual = InsightsOptions.from_params({"company_ids": [ids[0]], "force": True, "requested_by": rep})
    out = await run_insights(fake_settings(), repo, manual, provider=fake([BAD, BAD, BAD]))
    assert out["errors"] == 1 and out["llm_calls"] == 3
    (row,) = insight_rows(repo, ids[0])
    assert row["status"] == "error"
    (ev,) = insight_events(repo)
    assert ev["company_id"] == ids[0] and ev["payload"]["fields"] == ["insights"]
