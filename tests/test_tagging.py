import json
from pathlib import Path

from leadmaker.tagging import tag_lead
from leadmaker.tagging.rules import contact_roles, dedupe_contacts, explicit_title, region_for, same_person, target_contact

FIX = Path(__file__).parent / "fixtures"


def _keys(out):
    return {t["key"]: t for t in out["tags"]}


def test_gaf_only_lead_is_tagged_and_explained():
    out = tag_lead({"gaf_id": "1", "tier": "certified", "review_count": 0, "state": "NJ", "postal_code": "07026",
                    "city": "Garfield"})
    k = _keys(out)
    assert out["segment"] == "long_tail"
    assert k["gaf_tier"]["value"] == "certified" and k["review_volume"]["value"] == "none"
    assert k["region"]["value"] == "Essex/south Bergen area" and k["decision_maker"]["value"] == "none"
    assert all(t["reason"] and t["source"] for t in out["tags"])
    assert 0 <= out["priority_score"] <= 100


def test_strategic_master_elite_with_enrichment():
    lead = {
        "gaf_id": "2", "tier": "master_elite", "review_count": 474, "rating": 4.9, "presidents_club_stars": 1,
        "gaf_leads_enrolled": True, "distance_miles": 3.2, "state": "NY", "city": "Brooklyn", "postal_code": "11201",
        "in_business_since": 2005, "employees_range": "More than 5", "website": "https://x.com", "phone": "1",
        "contacts": [{"name": "Pat Doe", "title": "Owner", "confidence": 0.7, "source": "website"}],
        "enrichment": {
            "nyc_dcwp": {"status": "ok", "data": {"license_status": "Active", "license_number": "123-DCA",
                                                   "license_creation_date": "1999-01-01T00:00:00"}},
            "website_crawl": {"status": "ok", "data": {"services": ["slate_roofing", "commercial_roofing",
                                                                    "siding", "gutters"],
                                                       "emails": ["pat@x.com"], "social": {"facebook": "f"}}},
        },
    }
    out = tag_lead(lead)
    k = _keys(out)
    assert out["segment"] == "strategic"
    assert k["maturity"]["value"] == "veteran" and "nyc_dcwp" in k["maturity"]["reason"]  # oldest source wins
    assert k["nyc_hic_license"]["value"] == "active" and k["region"]["value"] == "Brooklyn"
    assert k["decision_maker"]["value"] == "identified" and k["direct_email"]
    assert {"premium_materials", "focus", "multi_trade"} <= set(k)
    assert out["priority_score"] >= 80
    assert "GAF tier" in k["priority_drivers"]["value"]


def test_growth_and_emerging_segments():
    assert tag_lead({"tier": "certified_plus", "review_count": 3})["segment"] == "growth"
    assert tag_lead({"tier": "certified", "review_count": 80, "rating": 4.7})["segment"] == "growth"
    assert tag_lead({"tier": "certified", "review_count": 4, "in_business_since": 2024})["segment"] == "emerging"


def test_missing_nyc_license_only_flagged_in_nyc():
    base = {"tier": "certified", "review_count": 0, "enrichment": {"nyc_dcwp": {"status": "no_match", "data": {}}}}
    assert "nyc_hic_license" in _keys(tag_lead({**base, "state": "NY", "city": "Bronx"}))
    assert "nyc_hic_license" not in _keys(tag_lead({**base, "state": "NJ", "city": "Garfield", "postal_code": "07026"}))


def test_region_lookup():
    assert region_for({"state": "NY", "city": "Flushing"}) == "Queens"
    assert region_for({"state": "NY", "city": "Yonkers"}) == "Westchester"
    assert region_for({"state": "NY", "city": "Westbury", "postal_code": "11590"}) == "Nassau County (LI)"
    assert region_for({"state": "NJ", "city": "Hackensack", "postal_code": "07601"}) == "Bergen/Hackensack area"


# --- size-aware target contact ------------------------------------------------
OFFICER = {"name": "Pat Doe", "title": "Company officer (FMCSA MCS-150)", "confidence": 0.89, "source": "fmcsa"}
OFFICE = {"name": "Ann Lee", "title": "Office Manager", "confidence": 0.6, "source": "website"}


def test_contact_roles_from_titles():
    assert contact_roles("Company officer (FMCSA MCS-150)") == {"owner"}
    assert contact_roles("Chairman/CEO (NY DOS filing)") == {"owner"}
    assert contact_roles("Service-of-process contact (NY DOS filing)") == {"other"}
    assert contact_roles("Service-of-process contact (NY DOS filing; often the LLC's owner)") == {"owner"}
    assert contact_roles("Owner / Office Manager") == {"owner", "office"}
    assert contact_roles("VP of Operations") == {"operations"}
    assert contact_roles("Vice President") == {"owner"}
    # "president" inside "Vice President of ..." must not make a functional VP an owner.
    assert contact_roles("Vice President of Sales") == {"sales"}
    assert contact_roles("Vice-President of Operations") == {"operations"}
    assert contact_roles("Chief Operating Officer") == {"operations"}
    assert contact_roles("Account Manager") == {"sales"}
    assert contact_roles("Accounts Payable") == {"office"}
    assert contact_roles("Purchasing Manager") == {"purchasing"}
    assert contact_roles("Senior Estimator") == {"project_manager"}
    assert contact_roles(None) == {"other"}


def test_small_firm_targets_owner_medium_targets_office():
    small = _keys(tag_lead({"tier": "certified", "review_count": 5, "employees_range": "1-5", "phone": "(212) 555-0100",
                            "contacts": [OFFICE, OFFICER]}))
    assert small["target_contact"]["value"] == "owner" and small["target_contact"]["contact"]["name"] == "Pat Doe"
    assert small["decision_maker"]["value"] == "identified"
    assert small["decision_maker"]["reason"].startswith("size=small → owner")
    medium = _keys(tag_lead({"tier": "certified", "review_count": 80, "employees_range": "More than 5",
                             "contacts": [OFFICER, OFFICE]}))
    assert medium["target_contact"]["value"] == "office" and medium["target_contact"]["contact"]["name"] == "Ann Lee"
    assert medium["decision_maker"]["value"] == "identified"  # same key, same values as before
    assert medium["decision_maker"]["label"] == "DM: Ann Lee (Office Manager)"
    assert "size=medium" in medium["decision_maker"]["reason"] and "office manager" in medium["decision_maker"]["reason"]
    # Unknown size behaves like small.
    unknown = target_contact({"contacts": [OFFICE, OFFICER]}, "unknown")
    assert unknown["role"] == "owner" and unknown["size"] == "unknown"


def test_dual_title_resolves_by_size():
    c = [{"name": "Lou Gray", "title": "Owner & Office Manager", "confidence": 0.6, "source": "website"}]
    assert target_contact({"contacts": c}, "small")["role"] == "owner"
    assert target_contact({"contacts": c}, "large")["role"] == "office"
    # A COO at a small firm is still a decision-maker, but is not presented as the "Owner".
    coo = [{"name": "Nicholas Kagios", "title": "Chief Operating Officer", "confidence": 0.75, "source": "website"}]
    t = target_contact({"contacts": coo}, "small")
    assert t["role"] == "operations" and t["status"] == "identified"


def test_low_confidence_preferred_role_does_not_beat_well_sourced_officer():
    shaky_pm = {"name": "Bo Ray", "title": "Project Manager", "confidence": 0.45, "source": "website"}
    t = target_contact({"contacts": [shaky_pm, OFFICER]}, "large")
    assert t["name"] == "Pat Doe" and t["status"] == "identified"
    assert "passed over project manager Bo Ray" in t["reason"]
    # With no stronger contact the shaky PM is still the named target, but only "weak".
    t2 = target_contact({"contacts": [shaky_pm]}, "large")
    assert t2["name"] == "Bo Ray" and t2["status"] == "weak"


def test_owner_fallback_on_main_phone_when_nobody_named():
    out = tag_lead({"tier": "certified", "review_count": 0, "phone": "(201) 555-0199"})
    k = _keys(out)
    assert k["decision_maker"]["value"] == "none" and "Owner" in k["decision_maker"]["label"]
    tc = k["target_contact"]
    assert tc["value"] == "owner" and tc["label"] == "Ask for: the Owner (name unknown, main line)"
    c = tc["contact"]
    assert c["name"] is None and c["fallback"] and c["phone"] == "(201) 555-0199" and c["phone_is_main_line"]
    assert out["target_contact"]["reason"].startswith("size=unknown → owner; no named decision-maker")


def test_weak_non_decision_maker_becomes_hint():
    sop = {"name": "Jo Smith", "title": "Service-of-process contact (NY DOS filing)", "confidence": 0.38, "source": "ny_dos"}
    sales = {"name": "Kim Park", "title": "Sales Manager", "confidence": 0.6, "source": "website"}
    k = _keys(tag_lead({"tier": "certified", "review_count": 0, "employees_range": "1-5", "phone": "1",
                        "contacts": [sales, sop]}))
    assert k["decision_maker"]["value"] == "weak"  # unchanged semantics: a person, but not a decision-maker
    tc = k["target_contact"]["contact"]
    assert tc["fallback"] and tc["name"] is None and tc["hint"]["name"] == "Kim Park"
    assert "possible contact: Kim Park" in k["target_contact"]["reason"]


def test_real_medium_lead_picks_project_manager_over_owner():
    lead = json.loads((FIX / "tagging_lead_records.json").read_text())["medium_with_pm_and_office"]
    out = tag_lead(lead)
    k = _keys(out)
    assert k["size"]["value"] == "medium"
    assert k["target_contact"]["value"] == "project_manager"
    assert k["target_contact"]["contact"]["name"] in {"Lucas Pena", "Mark Ford"}
    assert "passed over office manager" in k["decision_maker"]["reason"]  # office manager only at 0.45
    assert k["decision_maker"]["value"] == "identified" and out["priority_score"] >= 70


# --- TPO / single-ply / new construction --------------------------------------
def test_new_services_from_llm_keys_imply_broader_tags():
    out = tag_lead({"tier": "certified", "review_count": 0, "enrichment": {
        "llm_extract": {"status": "ok", "data": {"services": ["tpo_roofing", "new_construction"]}}}})
    k = _keys(out)
    assert k["service:tpo_roofing"]["label"] == "TPO roofing"
    assert k["service:new_construction"]["label"] == "New construction"
    assert {"service:single_ply_roofing", "service:flat_roofing", "focus"} <= set(k)
    wt = k["work_type:new_construction"]
    assert wt["value"] is True and wt["category"] == "work_type" and wt["source"] == "llm"
    assert "work_type:storm_emergency" not in k


def test_stored_page_text_is_rescanned_without_recrawl():
    lead = json.loads((FIX / "tagging_lead_records.json").read_text())["stored_text_tpo_new_construction"]
    stored = set(lead["enrichment"]["website_crawl"]["data"]["services"])
    assert not stored & {"tpo_roofing", "new_construction"}  # crawled before the detectors existed
    k = _keys(tag_lead(lead))
    assert {"service:tpo_roofing", "service:single_ply_roofing", "service:new_construction",
            "work_type:new_construction"} <= set(k)
    assert k["service:tpo_roofing"]["source"] == "website"


def test_storm_services_emit_work_type():
    k = _keys(tag_lead({"tier": "certified", "review_count": 0, "enrichment": {
        "website_crawl": {"status": "ok", "data": {"services": ["storm_damage", "roof_repair"]}}}}))
    assert "work_type:storm_emergency" in k and "storm_insurance" in k
    assert "work_type:new_construction" not in k


# --- audit fixes (Oct 2026): evidence in reasons, old-crawl re-derivation, contact dedupe -----------
def _crawl(data):
    return {"tier": "certified", "review_count": 0, "enrichment": {"website_crawl": {"status": "ok", "data": data}}}


def test_service_reason_cites_website_evidence_and_falls_back():
    k = _keys(tag_lead(_crawl({"services": ["new_construction", "roof_repair"], "service_evidence": {
        "new_construction": [{"url": "https://ffroofing.com/services", "snippet": "Re-roof | New Construction | Tear-Offs"}]}})))
    assert k["service:new_construction"]["reason"] == 'website: “Re-roof | New Construction | Tear-Offs” (https://ffroofing.com/services)'
    assert k["service:roof_repair"]["reason"] == "listed on company website"  # no evidence stored
    assert k["work_type:new_construction"]["value"] is True


def test_old_crawl_context_services_are_rederived_from_stored_text():
    # Crawled before service_evidence existed: stored services came from the old patterns over all pages.
    old = _crawl({"services": ["new_construction", "storm_damage", "emergency_service", "roof_repair"], "pages": [
        {"url": "https://www.nygeneralrenovation.com/terms-of-service",  # 7157319
         "text": "fully replaced any new construction systems (flat roof, pitched roof, whole window, whole door)"},
        {"url": "https://mcleodbrothers.com/about/",  # 1000796
         "text": "Vincent has consulted with Builders, Architects, Contractors, and Remodelers"},
        {"url": "https://www.example-roofer.com/services/stone/",  # 1100696
         "text": "lifetime transferable warranties, hurricane-resistant siding\nHurricane-Rated Materials"},
        {"url": "https://www.example-roofer.com/", "text": "hand you a written quote inside 24 hours.\nRoof repair"},
    ]})
    k = _keys(tag_lead(old))
    assert not {"service:new_construction", "service:storm_damage", "service:emergency_service",
                "work_type:new_construction", "work_type:storm_emergency"} & set(k)
    assert "service:roof_repair" in k  # non-context services from the stored list are kept
    # A context service that the stored text confirms survives, with the snippet as its reason.
    old["enrichment"]["website_crawl"]["data"]["pages"].append(
        {"url": "https://donnysroofing.com/", "text": "Our team specializes in new construction roofing."})  # 1139561
    k = _keys(tag_lead(old))
    assert "donnysroofing.com" in k["service:new_construction"]["reason"]
    # No mention at all in the stored text: the old hit lies in text that wasn't stored (1145215's "New
    # Construction" nav link, 1113999's "Winter Storm Damage" menu), so the stored service is kept.
    unseen = _crawl({"services": ["new_construction", "storm_damage"], "pages": [
        {"url": "https://carltoncm.com/", "text": "Construction management\nPre-construction services"}]})
    k = _keys(tag_lead(unseen))
    assert k["service:new_construction"]["reason"] == "listed on company website" and "service:storm_damage" in k
    # A crawl that stored service_evidence is page-aware already: its stored services are trusted.
    new = _crawl({"services": ["new_construction"], "service_evidence": {}, "pages": [
        {"url": "https://carltoncm.com/", "text": "Construction management"}]})  # 1145215 (evidence beyond stored text)
    assert "service:new_construction" in _keys(tag_lead(new))
    # ... and the stored text, which has lost the link context, can't add a context service back: 1156042's
    # homepage cards link to /blog/ posts.
    cards = _crawl({"services": ["general_contracting"], "service_evidence": {}, "pages": [
        {"url": "https://www.fahmihomesolutions.com/",
         "text": "Kitchen remodeling\nNew Construction Plumber in Wayne, NJ: 2026 Services, Costs & Hiring Guide"}]})
    assert "service:new_construction" not in _keys(tag_lead(cards))


def test_contacts_are_deduped_by_fuzzy_name():
    # 1143955: BBB spells "Giberto", FMCSA / NY DOS "Gilberto"; BBB abbreviates William's middle name.
    contacts = [
        {"name": "Gilberto Alas Quijada", "title": "Service-of-process contact (NY DOS filing)", "confidence": 0.38, "source": "ny_dos"},
        {"name": "Gilberto Alas Quijada", "title": "Company officer (FMCSA MCS-150)", "confidence": 0.81, "source": "fmcsa"},
        {"name": "William Alexander Alas Valdez", "title": "Company officer (FMCSA MCS-150)", "confidence": 0.81, "source": "fmcsa"},
        {"name": "William A. Alas Valdez", "title": "Co-owner", "confidence": 0.891, "source": "bbb"},
        {"name": "Giberto Alas Quijada", "title": "Co-owner", "confidence": 0.891, "source": "bbb"},
    ]
    people = {c["name"]: c for c in dedupe_contacts(contacts)}
    assert set(people) == {"Gilberto Alas Quijada", "William Alexander Alas Valdez"}
    g = people["Gilberto Alas Quijada"]
    assert g["title"] == "Co-owner" and g["source"] == "bbb" and g["confidence"] == 0.891
    assert g["also_sources"] == ["fmcsa", "ny_dos"]
    assert same_person("Giberto Alas Quijada", "Gilberto Alas Quijada")
    assert not same_person("John Smith", "Joan Smith") and not same_person("Christina Marrone", "Andrea Marrone")
    # 1006073: BBB lists two Carolans (father / son); different middle initials are different people.
    assert not same_person("Edward B. Carolan", "Edward P. Carolan")
    assert not same_person("Ronald Smith Jr.", "Ronald Smith Sr.")
    assert not same_person("Paul Russo", "Paula Russo") and not same_person("Antonio Rossi", "Antonia Rossi")
    assert same_person("John Schenone", "John M. Schenone") and same_person("Randall Cecilliano", "Randall Cecillano")
    assert same_person("Louis G. Ricci", "Louis George Ricci IV") and same_person("Ronald Smith", "Ronald John Smith Jr.")
    t = target_contact({"contacts": contacts}, "small")
    assert t["title"] == "Co-owner" and t["status"] == "identified"


def test_stated_title_beats_generic_officer_note_on_tie():
    # 1111953: the same Robert Cooley is an FMCSA "Company officer" and BBB "President", both 0.891.
    contacts = [
        {"name": "Robert Cooley", "title": "Chairman/CEO (NY DOS filing)", "confidence": 0.855, "source": "ny_dos"},
        {"name": "Robert Cooley", "title": "Company officer (FMCSA MCS-150)", "confidence": 0.891, "source": "fmcsa"},
        {"name": "Robert Cooley", "title": "President", "confidence": 0.891, "source": "bbb"},
    ]
    t = target_contact({"contacts": contacts}, "unknown")
    assert (t["name"], t["title"], t["source"]) == ("Robert Cooley", "President", "bbb")
    # Different people, same tier: a stated title wins only within a small confidence margin, so a 0.6
    # website "Founder" (template filler "Jane Doe" on 1160078) does not beat a 0.81 BBB officer.
    officer = {"name": "Chris Donaldson", "title": "Company officer (FMCSA MCS-150)", "confidence": 0.891, "source": "fmcsa"}
    ceo = {"name": "Carl Culbreth", "title": "Chairman/CEO (NY DOS filing)", "confidence": 0.855, "source": "ny_dos"}
    assert target_contact({"contacts": [officer, ceo]}, "small")["name"] == "Carl Culbreth"  # 1114517
    vp = {"name": "Fareed Butt", "title": "Vice President", "confidence": 0.81, "source": "bbb"}
    filler = {"name": "Jane Doe", "title": "Founder", "confidence": 0.6, "source": "website"}
    assert target_contact({"contacts": [filler, vp]}, "small")["name"] == "Fareed Butt"
    assert explicit_title("President") and explicit_title("Chairman/CEO (NY DOS filing)")
    assert not explicit_title("Company officer (FMCSA MCS-150)") and not explicit_title("Vice President")


def test_bbb_business_management_is_usable_when_no_owner_is_named():
    # 1135399: BBB lists Geraldo Metko with no title ("Business management").
    metko = {"name": "Geraldo Metko", "title": "Business management", "confidence": 0.891, "source": "bbb"}
    assert contact_roles("Business management") == {"operations"}
    for size in ("small", "unknown"):
        t = target_contact({"contacts": [metko]}, size)
        assert t["name"] == "Geraldo Metko" and t["role"] == "operations" and t["status"] == "identified"
    # A named owner still wins, at every size (1001655: Lawrence Ferrari, President, over Stephen Ferrari).
    owner = {"name": "Lawrence Ferrari", "title": "President", "confidence": 0.891, "source": "bbb"}
    for size in ("small", "medium", "large"):
        assert target_contact({"contacts": [metko, owner]}, size)["name"] == "Lawrence Ferrari"
    # BBB's bare "Manager" is the same kind of listing (1163450 Toni B; 1131213: the Owner, Mary Cuppari, still wins).
    assert target_contact({"contacts": [{"name": "Toni B", "title": "Manager", "confidence": 0.891, "source": "bbb"}]},
                          "small")["role"] == "operations"
    cuppari = [{"name": "Frank Cuppari", "title": "Manager", "confidence": 0.891, "source": "bbb"},
               {"name": "Mary Cuppari", "title": "Owner", "confidence": 0.891, "source": "bbb"}]
    assert target_contact({"contacts": cuppari}, "medium")["name"] == "Mary Cuppari"
    # An explicit operations title outranks the generic management listing.
    ops = {"name": "Ana Ruiz", "title": "Operations Manager", "confidence": 0.6, "source": "website"}
    assert target_contact({"contacts": [metko, ops]}, "small")["name"] == "Ana Ruiz"
