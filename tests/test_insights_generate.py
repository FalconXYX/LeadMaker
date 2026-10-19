"""generate(): one batch call, items mapped by lead_ref, one retry with feedback for missing or invalid items,
per-lead retries after an unusable batch answer, provider errors turned into deferred results (no row)."""

from __future__ import annotations

from datetime import datetime, timezone

from leadmaker.insights import LeadFacts, generate, input_hash
from leadmaker.insights.generate import feedback, items_by_ref, norm_ref
from leadmaker.llm import LlmApiError, LlmAuthError, LlmOutputError, LlmQuotaExceeded, LlmRateLimited

from test_insights_support import ME_LEAD, fake, lead, valid_item

A = lead(ME_LEAD, "a")
B = lead([("business_name", "business_name: Tiny Repairs"), ("services", "services: Storm damage, Insurance claims")], "b")
C = lead([("business_name", "business_name: Flat Roof Co"), ("materials", "materials: TPO roofing")], "c")


def b_item(ref: str = "L2", **over):
    item = {"lead_ref": ref, "summary": "Tiny Repairs is a roofing contractor doing storm damage work.",
            "summary_facts": ["F1", "F2"], "pitch": "Lead with emergency tarps and repair stock for storm work.",
            "pitch_facts": ["F2"], "talking_points": [{"text": "Ask what work they do most.", "facts": ["F1"]},
                                                      {"text": "Ask how insurance claims affect orders.", "facts": ["F2"]}],
            "target_contact": None, "product_focus": ["tarps_emergency_repair"]}
    item.update(over)
    return item


def test_refs_are_normalised():
    assert [norm_ref(r) for r in ("L2", "l2", " L2 ", "2", None)] == ["L2", "L2", "L2", "L2", ""]
    assert items_by_ref({"insights": [b_item("l2"), b_item("L2", summary="second")]})["L2"]["summary"].startswith("Tiny")
    assert items_by_ref({"insights": "nope"}) == {} and items_by_ref(None) == {}


def test_feedback_message():
    assert feedback({"L2": ["cited F19, which does not exist"], "L3": ["says 'Master Elite', which is not in the facts"]}) == (
        "Your previous answer had problems:\n- L2: cited F19, which does not exist\n"
        "- L3: says 'Master Elite', which is not in the facts\nReturn corrected JSON for these leads only.")


async def test_one_call_for_a_batch_mapped_by_ref_in_any_order():
    p = fake([{"insights": [b_item("l2"), valid_item("L1")]}])
    stats: dict = {}
    out = await generate(p, None, [A, B], stats=stats)
    assert [r.company_id for r in out] == ["a", "b"] and all(r.ok for r in out)
    assert stats == {"llm_calls": 1} and len(p.calls) == 1
    assert out[0].insight["pitch"].startswith("Lead with bulk architectural shingles")
    assert out[0].attempts == 1 and out[0].model == "fake:fake-1" and out[0].input_hash == input_hash(A, "fake:fake-1")
    assert out[0].usage["batch_size"] == 2 and out[0].usage["input_tokens"] == len(p.calls[0]["user"]) // 4 // 2
    assert '<lead ref="L1">' in p.calls[0]["user"] and '<lead ref="L2">' in p.calls[0]["user"]


async def test_a_missing_item_is_retried_alone_with_feedback():
    p = fake([{"insights": [valid_item("L1")]}, {"insights": [b_item("L2")]}])
    out = await generate(p, None, [A, B])
    assert [r.ok for r in out] == [True, True] and [r.attempts for r in out] == [1, 2]
    retry = p.calls[1]["user"]
    assert '<lead ref="L2">' in retry and '<lead ref="L1">' not in retry  # same ref, only that lead
    assert retry.endswith("- L2: no item was returned for this lead\nReturn corrected JSON for these leads only.")


async def test_invalid_items_are_retried_together_and_a_second_failure_is_an_error_result():
    bad_b = b_item(summary_facts=["F1", "F19"])
    bad_c = {**b_item("L3"), "pitch": "Lead with TPO for this Master Elite flat roof shop.", "summary_facts": ["F1"],
             "pitch_facts": ["F2"], "talking_points": [{"text": "Ask what work they do most.", "facts": ["F1"]},
                                                       {"text": "Ask which TPO jobs are coming up.", "facts": ["F2"]}],
             "summary": "Flat Roof Co is a roofing contractor doing TPO work.", "product_focus": ["tpo_membrane"]}
    good_c = {**bad_c, "pitch": "Lead with TPO membrane and flat-roof accessories for their commercial work."}
    p = fake([{"insights": [valid_item("L1"), bad_b, bad_c]}, {"insights": [bad_b, good_c]}])
    out = await generate(p, None, [A, B, C])
    assert [r.ok for r in out] == [True, False, True] and [r.attempts for r in out] == [1, 2, 2]
    assert out[1].violations == ["cited F19, which does not exist"] and out[1].insight is None
    assert out[1].deferred is None  # an error row is written for it
    retry = p.calls[1]["user"]
    assert '<lead ref="L2">' in retry and '<lead ref="L3">' in retry and '<lead ref="L1">' not in retry
    assert "- L2: cited F19, which does not exist" in retry
    assert "- L3: says 'Master Elite', which is not in the facts" in retry
    assert out[1].usage["batch_size"] == 2  # the retry's usage, split over its 2 leads


async def test_an_unusable_batch_answer_retries_each_lead_alone():
    p = fake([LlmOutputError("truncated", provider="fake"), {"insights": [valid_item("L1")]},
              "not json at all"])
    out = await generate(p, None, [A, B])
    assert len(p.calls) == 3
    assert '<lead ref="L1">' in p.calls[1]["user"] and '<lead ref="L2">' not in p.calls[1]["user"]
    assert '<lead ref="L2">' in p.calls[2]["user"] and '<lead ref="L1">' not in p.calls[2]["user"]
    assert "Your previous answer" not in p.calls[1]["user"]
    assert out[0].ok and not out[1].ok and out[1].attempts == 2
    assert out[1].violations[0].startswith("the previous answer was unusable")
    assert out[1].violations[-1].startswith("retry was unusable too")


async def test_a_single_lead_with_an_unusable_answer_retries_once():
    p = fake([LlmOutputError("blocked", provider="fake")])  # then template mode: a valid item
    (r,) = await generate(p, None, [A])
    assert r.ok and r.attempts == 2 and len(p.calls) == 2


async def test_quota_on_the_first_call_defers_every_lead_with_the_reset_time():
    resets = datetime(2026, 10, 20, 7, tzinfo=timezone.utc)
    p = fake([LlmQuotaExceeded("daily quota", provider="fake", resets_at=resets)])
    out = await generate(p, None, [A, B])
    assert [r.deferred for r in out] == ["quota", "quota"] and not any(r.ok for r in out)
    assert out[0].resets_at == resets.isoformat() and out[0].error == "daily quota" and out[0].attempts == 1


async def test_auth_on_the_retry_keeps_the_good_items_and_defers_the_rest():
    p = fake([{"insights": [valid_item("L1")]}, LlmAuthError("bad key", provider="fake")])
    out = await generate(p, None, [A, B])
    assert out[0].ok and out[0].deferred is None
    assert out[1].deferred == "auth" and not out[1].ok


async def test_rate_limit_or_api_error_on_the_retry_defers_those_leads():
    for exc, kind in ((LlmRateLimited("slow", provider="fake"), "rate_limited"),
                      (LlmApiError("500", provider="fake"), "api")):
        p = fake([{"insights": [valid_item("L1")]}, exc])
        out = await generate(p, None, [A, B])
        assert out[0].ok and out[1].deferred == kind


async def test_provider_errors_on_the_first_call_defer_everything():
    for exc, kind in ((LlmAuthError("bad key", provider="fake"), "auth"), (LlmApiError("down", provider="fake"), "api"),
                      (LlmRateLimited("slow", provider="fake"), "rate_limited")):
        out = await generate(fake([exc]), None, [A, B])
        assert [r.deferred for r in out] == [kind, kind]


async def test_skipped_leads_are_never_sent():
    dnc = LeadFacts(company_id="d", business_name="Do Not Call LLC", facts=B.facts, skip_reason="do_not_contact")
    p = fake()
    out = await generate(p, None, [dnc, A, dnc])
    assert [r.company_id for r in out] == ["d", "a", "d"]
    assert out[0].deferred == "do_not_contact" and out[0].attempts == 0 and out[1].ok
    assert len(p.calls) == 1 and "Do Not Call" not in p.calls[0]["user"]
    p2 = fake()
    assert [r.deferred for r in await generate(p2, None, [dnc])] == ["do_not_contact"] and p2.calls == []
    assert await generate(p2, None, []) == []


async def test_the_template_fake_produces_valid_results_for_a_whole_batch():
    p = fake()
    out = await generate(p, None, [A, B, C])
    assert all(r.ok for r in out) and len(p.calls) == 1
    assert [r.insight["product_focus"] for r in out] == [["architectural_shingles"], ["tarps_emergency_repair"],
                                                         ["tpo_membrane"]]


async def test_an_item_that_repeats_another_lead_s_private_note_is_rejected():
    """Security review M1: one batch call carries several leads; an item for lead A that copies lead B's note passes
    every per-lead guard, so generate() also checks it against the other leads' private facts."""
    from leadmaker.insights.validate import cross_lead_problems

    victim = lead([("business_name", "business_name: Tiny Repairs"), ("services", "services: Roof repair"),
                   ("note", "note (Priya S., 2026-10-12): Owner is unhappy with pricing and is moving the account "
                            "to ABC Supply unless the quote drops by 12 percent")], "b")
    leak = valid_item("L1", talking_points=[
        {"text": "Ask whether moving the account to ABC Supply is on the table.", "facts": ["F8"]},
        {"text": "Ask how the 4.8-star rating is holding up.", "facts": ["F5"]}])
    assert validate_item_ok(leak, A)  # every per-lead guard passes
    victim_item = b_item("L2", summary_facts=["F1"], pitch_facts=["F2"], summary="Tiny Repairs is a roof repair shop.",
                         pitch="Lead with underlayment and repair stock for their roof repair work.",
                         talking_points=[{"text": "Ask what work they do most.", "facts": ["F1"]},
                                         {"text": "Ask which repairs keep crews busiest.", "facts": ["F2"]}])
    p = fake([{"insights": [leak, victim_item]}, {"insights": [valid_item("L1")]}])
    out = await generate(p, None, [A, victim])
    assert out[0].ok and out[1].ok and out[0].attempts == 2 and out[1].attempts == 1
    assert "- L1: repeats another lead's private notes or data" in p.calls[1]["user"]
    assert '<lead ref="L2">' not in p.calls[1]["user"]  # the retry holds only the failing lead
    assert cross_lead_problems(leak, A, [victim]) and cross_lead_problems(leak, A, []) == []
    # text both leads share (a town, a service) is not a leak
    assert cross_lead_problems(valid_item("L1"), A, [victim]) == []


def validate_item_ok(item, facts) -> bool:
    from leadmaker.insights import validate_item

    return validate_item(item, facts) == []


async def test_repairable_items_pass_on_the_first_call():
    item = valid_item(target_contact={"name": "Unknown", "title": "Owner", "why": "Ask on the main line.", "facts": ["F7"]},
                      product_focus=["architectural_shingles", "underlayment", "ventilation", "starter_hip_ridge"])
    p = fake([{"insights": [item]}])
    (r,) = await generate(p, None, [A])
    assert r.ok and r.attempts == 1 and len(p.calls) == 1
    assert r.insight["target_contact"] is None and r.insight["product_focus"] == [
        "architectural_shingles", "underlayment", "ventilation"]
