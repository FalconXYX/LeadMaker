"""validate_item: every guard produces a model-readable violation; a grounded item passes; clean_item's shape."""

from __future__ import annotations

import pytest

from leadmaker.insights import validate_item
from leadmaker.insights.validate import clean_item, is_role_only, text_problems

from test_insights_support import ME_LEAD, lead, valid_item

ME = lead(ME_LEAD)
CERTIFIED = lead([("business_name", "business_name: Golovin Roofing LLC"),
                  ("location", "location: Flushing, NY 11358"),
                  ("gaf_tier", "gaf_tier: GAF Certified"),
                  ("services", "services: Roof replacement, Gutters")])
UNCERTIFIED = lead([("business_name", "business_name: Tiny Repairs"), ("gaf_tier", "gaf_tier: no GAF certification"),
                    ("services", "services: Roof repair")])


def tiny_item(**over):
    item = {"lead_ref": "L1", "summary": "Tiny Repairs is a small roofing contractor doing repairs.",
            "summary_facts": ["F1", "F3"], "pitch": "Lead with architectural shingles and underlayment for repairs.",
            "pitch_facts": ["F3"], "talking_points": [{"text": "Ask what work they do most.", "facts": ["F1"]},
                                                      {"text": "Ask which repairs keep crews busiest.", "facts": ["F3"]}],
            "target_contact": None, "product_focus": ["architectural_shingles"]}
    item.update(over)
    return item


def test_a_grounded_item_passes():
    assert validate_item(valid_item(), ME) == []
    assert validate_item(tiny_item(), UNCERTIFIED) == []


@pytest.mark.parametrize("over, expected", [
    ({"summary_facts": ["F1", "F19"]}, "cited F19, which does not exist"),
    ({"talking_points": [{"text": "Ask about the 4.8-star rating today.", "facts": ["F5"]},
                         {"text": "Ask about deliveries from the yard.", "facts": ["F0"]}]}, "cited F0, which does not exist"),
    ({"summary_facts": []}, "summary cites no facts"),
    ({"pitch_facts": []}, "pitch cites no facts"),
    ({"talking_points": [{"text": "Ask about the 4.8-star rating today.", "facts": []},
                         {"text": "Ask about deliveries from the yard.", "facts": ["F8"]}]}, "talking point 1 cites no facts"),
    ({"summary": "Short."}, "summary is 6 characters (min 20)"),
    ({"summary": "x" * 421}, "summary is 421 characters (max 420)"),
    ({"pitch": "Lead with shingles. " * 31}, "pitch is 619 characters (max 600)"),
    ({"pitch": "Lead with shingles for " + "a very busy replacement shop " * 6 + ". Then ask."},
     "pitch's first sentence is"),
    ({"talking_points": [{"text": "Ask about the 4.8-star rating today.", "facts": ["F5"]}]},
     "has 1 talking points (need 2-4)"),
    ({"talking_points": [{"text": "Ask.", "facts": ["F5"]}, {"text": "Ask about deliveries.", "facts": ["F8"]}]},
     "talking point 1 is 4 characters (min 10)"),
    ({"talking_points": [{"text": f"Ask about item {i} on the list.", "facts": ["F5"]} for i in range(5)]},
     "has 5 talking points (need 2-4)"),
    ({"product_focus": []}, "product_focus needs 1-3 distinct values (got [])"),
    ({"product_focus": ["underlayment", "underlayment"]}, "product_focus needs 1-3 distinct values"),
    ({"product_focus": ["siding", "skylights", "insulation", "ventilation"]}, "product_focus needs 1-3 distinct values"),
    ({"product_focus": ["solar_panels"]}, "product_focus has values outside the allowed list: ['solar_panels']"),
    ({"target_contact": {"name": "Jose Sucuzhanay Sr.", "title": "President", "why": "w" * 101, "facts": ["F7"]}},
     "target_contact.why is 101 characters (max 100)"),
    ({"target_contact": {"name": "Maria Lopez", "title": "Office Manager", "why": "Handles orders.", "facts": ["F7"]}},
     "target_contact 'Maria Lopez' is not named in the facts"),
    ({"target_contact": {"name": "Owner", "title": "Owner", "why": "Decides on suppliers.", "facts": ["F7"]}},
     "target_contact 'Owner' is a role, not a named person"),
    ({"pitch": "Lead with shingles; email jose@carework.com for the quote."}, "contains an email address"),
    ({"pitch": "Lead with shingles; call (201) 555-0142 to set it up."}, "contains a phone number"),
    ({"summary": "Carework Construction LLC roofs homes in Lyndhurst; see www.carework.com for photos."},
     "contains a URL"),
    ({"pitch": "Lead with tarps before tomorrow's storm hits Lyndhurst."}, "mentions weather or timing ('tomorrow')"),
    ({"talking_points": [{"text": "Mention the forecast for their area.", "facts": ["F2"]},
                         {"text": "Ask about deliveries from the yard.", "facts": ["F8"]}]},
     "mentions weather or timing ('forecast')"),
    ({"pitch": "Lead with tarps; the NWS has their county covered."}, "mentions weather or timing ('NWS')"),
    ({"summary": "Carework is a roofer; a wind advisory covers Bergen County."}, "mentions weather or timing ('advisory')"),
    ({"summary": "Carework Construction LLC is a President's Club roofer in Lyndhurst."},
     "says 'President's Club', which is not in the facts"),
    ({"pitch": "Lead with shingles for this Triple Excellence award winner."},
     "says 'Triple Excellence', which is not in the facts"),
    ({"summary": None}, "does not match the schema"),
])
def test_each_guard_produces_a_violation(over, expected):
    problems = validate_item(valid_item(**over), ME)
    assert any(expected in p for p in problems), problems


def test_certification_guard_against_the_lead_s_own_tier():
    item = tiny_item(summary="Golovin Roofing LLC is a GAF Master Elite contractor in Flushing.",
                     summary_facts=["F1", "F3"], pitch_facts=["F4"], talking_points=[
                         {"text": "Ask what work they do most.", "facts": ["F1"]},
                         {"text": "Ask how gutters fit with their roofing jobs.", "facts": ["F4"]}])
    assert "says 'Master Elite', which is not in the facts" in validate_item(item, CERTIFIED)
    ok = tiny_item(summary="Golovin Roofing LLC is a GAF certified roofer in Flushing.", talking_points=[
        {"text": "Ask what work they do most.", "facts": ["F1"]},
        {"text": "Ask how gutters fit with their roofing jobs.", "facts": ["F4"]}], pitch_facts=["F4"])
    assert validate_item(ok, CERTIFIED) == []
    # "certified" alone is grounded by any GAF tier; a contractor without one cannot be called certified
    assert validate_item(tiny_item(summary="Tiny Repairs is a certified roofer doing repairs."), UNCERTIFIED) == [
        "says 'Certified', which is not in the facts"]
    # Master Elite is a GAF certification, so "GAF-certified" passes for a Master Elite lead
    assert validate_item(valid_item(summary="Carework Construction LLC is a GAF-certified Master Elite roofer."), ME) == []


def test_a_self_description_never_grounds_a_certification():
    bragging = lead([*((k, t) for k, t in ME_LEAD if k not in ("gaf_tier", "certification")),
                     ("gaf_tier", "gaf_tier: GAF Certified"),
                     ("gaf_description", "gaf_description: The only GAF Master Elite, President's Club roofer here!")])
    item = valid_item(summary="Carework Construction LLC is a GAF Master Elite roofer in Lyndhurst.",
                      pitch="Lead with architectural shingles for this busy replacement shop.", pitch_facts=["F5"])
    assert "says 'Master Elite', which is not in the facts" in validate_item(item, bragging)
    # a rep's note is the distributor's own record and does ground the phrase
    noted = lead([*ME_LEAD[:2], ("gaf_tier", "gaf_tier: GAF Certified"),
                  ("note", "note (Jordan L., 2026-10-07): Wants Master Elite rewards on our orders")])
    assert text_problems("Ask about the Master Elite rewards they asked for.", [f.text for f in noted.facts]) == []


def test_phrases_are_matched_case_and_punctuation_insensitively():
    facts = [f.text for f in ME.facts]
    assert text_problems("A MASTER-ELITE shop", facts) == []
    assert text_problems("A presidents club member", facts) == ["says 'President's Club', which is not in the facts"]
    assert text_problems("An elite crew", [f.text for f in CERTIFIED.facts]) == ["says 'Elite', which is not in the facts"]
    assert text_problems("Contractor next door", facts) == []  # "next" is fine; only "next week" is timing


def test_role_only_names():
    assert is_role_only("Owner") and is_role_only("Office Manager") and is_role_only("the owner") and is_role_only("")
    assert not is_role_only("Jose Sucuzhanay Sr.") and not is_role_only("Maria Lopez, Office Manager")


def test_name_guard_tolerates_case_and_punctuation():
    item = valid_item(target_contact={"name": "jose sucuzhanay sr", "title": "President", "why": "Owner.",
                                      "facts": ["F7"]})
    assert validate_item(item, ME) == []


def test_clean_item_strips_contact_fact_ids_and_lists_cited_facts_in_fact_order():
    out = clean_item(valid_item(summary="  Carework   Construction LLC is a GAF Master Elite roofer in Lyndhurst. "), ME)
    assert out["summary"] == "Carework Construction LLC is a GAF Master Elite roofer in Lyndhurst."
    assert out["target_contact"] == {"name": "Jose Sucuzhanay Sr.", "title": "President",
                                     "why": "Owner; signs off on suppliers."}
    assert [c["id"] for c in out["cited_facts"]] == ["F1", "F2", "F3", "F5", "F6", "F7", "F8"]
    assert out["cited_facts"][2] == {"id": "F3", "text": "gaf_tier: GAF Master Elite"}
    assert out["talking_points"] == ["Ask how the 4.8-star rating is holding up as they add crews.",
                                     "Follow up on the late deliveries from their current supplier."]
    assert set(out) == {"summary", "pitch", "talking_points", "target_contact", "product_focus", "cited_facts"}


# ---- insights/v2 guards (2026-10-19 review: distributor promises, second person, filler timing words) ------------

@pytest.mark.parametrize("over, expected", [
    ({"talking_points": [{"text": "We provide reliable next-day delivery on shingles in Bergen County.", "facts": ["F2"]},
                         {"text": "Ask how the 4.8-star rating is holding up.", "facts": ["F5"]}]},
     "speaks for the distributor ('We ... provide')"),
    ({"talking_points": [{"text": "How can our distribution yard in Garfield support their projects?", "facts": ["F2"]},
                         {"text": "Ask how the 4.8-star rating is holding up.", "facts": ["F5"]}]},
     "speaks for the distributor ('our ... yard')"),
    ({"pitch": "Lead with shingles; we offer tiered volume pricing for large contractors."},
     "speaks for the distributor"),
    ({"pitch": "Lead with tarps and emergency repair stock, alongside ice and water shield, given their focus on "
               "storm damage restoration."}, "pitch strings products together in a list"),
    ({"talking_points": [{"text": "Since no financing is advertised, have they considered payment options?", "facts": ["F2"]},
                         {"text": "Ask how the 4.8-star rating is holding up.", "facts": ["F5"]}]},
     "talking point 1 is about 'financing'"),
    ({"talking_points": [{"text": "Since they do storm work, how is their tarp supply?", "facts": ["F2"]},
                         {"text": "Since they are Master Elite, who supplies their shingles?", "facts": ["F5"]}]},
     "talking points open the same way"),
    ({"summary": "Your contractor Carework Construction LLC roofs homes in Lyndhurst."},
     "summary says 'Your'"),
    ({"talking_points": [{"text": "What materials do they need for upcoming projects?", "facts": ["F6"]},
                         {"text": "Ask how the 4.8-star rating is holding up.", "facts": ["F5"]}]},
     "mentions season or urgency ('upcoming')"),
    ({"pitch": "Lead with ice and water shield ahead of the winter season for this shop."},
     "mentions season or urgency ('winter')"),
    ({"pitch": "Lead with dependable delivery schedules and a new credit application."}, "pitch names no product line"),
])
def test_v2_guards(over, expected):
    problems = validate_item(valid_item(**over), ME)
    assert any(expected in p for p in problems), problems


def test_v3_questions_and_offers_to_check_are_not_promises():
    ok = valid_item(
        pitch="High-volume replacement shop, so architectural shingles by the truckload are the way in. When you call, "
              "ask who supplies them today and offer to check lead times on the colors they run.",
        talking_points=[{"text": "Would it help if we could stage material on the roof for their crews?", "facts": ["F2"]},
                        {"text": "I can check whether we have the colors they use most on hand.", "facts": ["F5"]},
                        {"text": "Who's supplying their shingles right now?", "facts": ["F8"]}])
    assert validate_item(ok, ME) == []
    bad = valid_item(talking_points=[{"text": "We can deliver next day from our yard, want to try it?", "facts": ["F2"]},
                                     {"text": "Ask how the 4.8-star rating is holding up.", "facts": ["F5"]}])
    assert any("speaks for the distributor" in p for p in validate_item(bad, ME))


def test_a_fact_grounds_distributor_terms_and_timing_words():
    noted = lead([*ME_LEAD, ("note", "note (Jordan L., 2026-10-09): Wants rooftop delivery and net 30 terms before winter")])
    ok = valid_item(talking_points=[
        {"text": "Confirm our rooftop delivery and net 30 terms work for their crews.", "facts": ["F9"]},
        {"text": "Ask what they need on hand before winter.", "facts": ["F9"]}])
    assert validate_item(ok, noted) == []
    # talking points may speak to the contractor; the summary and pitch may not
    assert validate_item(valid_item(talking_points=[
        {"text": "Ask how your crews keep the 4.8-star rating as you grow.", "facts": ["F5"]},
        {"text": "Follow up on the late deliveries from their current supplier.", "facts": ["F8"]}]), ME) == []


def test_the_website_excerpt_is_cited_as_w1():
    with_site = lead(ME_LEAD, website="Storm restoration and roof replacement in Bergen County.")
    item = valid_item(summary_facts=["F1", "W1"])
    assert validate_item(item, with_site) == []
    assert "cited W1, which does not exist" in validate_item(item, ME)
    cited = clean_item(item, with_site)["cited_facts"]
    assert cited[-1] == {"id": "W1", "text": "website: the company's website"}


def test_repair_item_fixes_what_needs_no_model():
    from leadmaker.insights.validate import repair_item

    item = valid_item(target_contact={"name": "Owner", "title": "Owner", "why": "Decides.", "facts": ["F7"]},
                      product_focus=["siding", "siding", "solar_panels", "gutters_drainage", "insulation", "skylights"],
                      talking_points=[{"text": f"{w} about the 4.8-star rating, part {i}.", "facts": ["F5"]}
                                      for i, w in enumerate(("Ask", "Talk", "Check", "Chat", "Learn", "Hear"))])
    fixed = repair_item(item)
    assert fixed["target_contact"] is None
    assert fixed["product_focus"] == ["siding", "gutters_drainage", "insulation"]
    assert len(fixed["talking_points"]) == 4 and validate_item(fixed, ME) == []
    assert item["target_contact"] is not None  # the input is not mutated
    assert repair_item(None) is None and repair_item({"product_focus": ["solar_panels"]})["product_focus"] == ["solar_panels"]


def test_a_generic_offer_of_help_is_not_a_promise():
    assert validate_item(valid_item(talking_points=[
        {"text": "Ask how we can support their crews on large replacement jobs.", "facts": ["F6"]},
        {"text": "Follow up on the late deliveries from their current supplier.", "facts": ["F8"]}]), ME) == []


@pytest.mark.parametrize("text", [
    "Offer to check our metal stock for their standing-seam jobs.",
    "See if our stock of standing-seam panels fits their next job.",
    "Ask whether our metal inventory could back up their current supplier.",
])
def test_an_offer_to_check_our_stock_is_not_a_claim(text):
    # The retry feedback asks for "an offer to check"; "check our metal stock" is that offer (Ship, 2026-10-19: a
    # profile Refresh failed twice on it).
    assert text_problems(text, ["custom_tag: Metal roofing specialist"]) == []


@pytest.mark.parametrize("text", [
    "We stock standing-seam panels for their metal jobs.",
    "Our yard carries metal panels in every gauge.",
    "Position us as their second supplier with our metal stock.",
    "Check lead times, since our metal stock ships same day.",
])
def test_a_claim_about_our_stock_still_fails(text):
    assert any("speaks for the distributor" in p for p in text_problems(text, ["custom_tag: Metal roofing specialist"]))
