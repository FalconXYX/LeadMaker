"""FMCSA census enricher: matching + output contract (offline, synthetic carrier rows)."""

from leadmaker.config import Settings
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.fmcsa import FmcsaEnricher, score
from leadmaker.models import EnrichmentStatus

CONTRACTOR = {"gaf_id": "1", "name": "Jersey Roofing LLC", "legal_name": "Jersey Roofing LLC", "phone": "(201) 982-2718",
              "postal_code": "07026", "city": "Garfield", "state": "NJ"}
ROW_PHONE = {"dot_number": "111", "legal_name": "JERSEY ROOFING LLC", "phone": "2019822718", "phy_zip": "07026",
             "phy_city": "GARFIELD", "phy_state": "NJ", "company_officer_1": "JOHN Q PUBLIC", "company_officer_2": "",
             "email_address": "Owner@Example.com", "power_units": "3", "total_drivers": "2"}
ROW_OTHER = {"dot_number": "222", "legal_name": "JERSEY ROOFING SUPPLY INC", "phone": "9735550000", "phy_zip": "07102",
             "phy_city": "NEWARK", "phy_state": "NJ", "company_officer_1": "SOMEONE ELSE"}


def _enricher(rows):
    e = FmcsaEnricher(Settings())
    for r in rows:
        e.rows[r["dot_number"]] = r
        e.by_phone["2019822718" if r is ROW_PHONE else "9735550000"].add(r["dot_number"])
        e.by_token["jersey"].add(r["dot_number"])
    return e


def test_phone_match_beats_similar_name():
    assert score(CONTRACTOR, ROW_PHONE)[0] >= 0.9
    assert score(CONTRACTOR, ROW_OTHER)[0] < 0.75


async def test_enrich_emits_officer_contact_with_email():
    r = await _enricher([ROW_PHONE, ROW_OTHER]).enrich(LeadContext(contractor=CONTRACTOR), http=None)
    assert r.status == EnrichmentStatus.OK and r.data["dot_number"] == "111"
    assert r.data["officers"] == ["John Q Public"] and r.data["email"] == "owner@example.com"
    (c,) = r.contacts
    assert c.title.startswith("Company officer") and c.email == "owner@example.com" and c.source == "fmcsa"


async def test_short_name_without_phone_is_rejected():
    abc = {**CONTRACTOR, "name": "ABC", "legal_name": "ABC", "phone": None}
    row = {**ROW_OTHER, "legal_name": "ABC", "phy_zip": "07026", "phy_city": "GARFIELD"}
    e = _enricher([row])
    e.by_token["abc"].add(row["dot_number"])
    r = await e.enrich(LeadContext(contractor=abc), http=None)
    assert r.status == EnrichmentStatus.NO_MATCH


# Real audited false positives (Oct 2026 run): the contractor's phone is on a USDOT registration of a
# differently named business in another town -- the owner's trucking side line, not the roofer.
AUDIT_PHONE_ONLY = [
    # GAF 1160787 "VMF Construction LLC", Fair Lawn 07410 -> KOS-TRANS LLC, Garfield (name_sim 0.0, inactive)
    ({"gaf_id": "1160787", "name": "VMF Construction LLC", "legal_name": "VMF Construction LLC", "phone": "(201) 555-0187",
      "postal_code": "07410", "city": "Fair Lawn", "state": "NJ"},
     {"dot_number": "901", "legal_name": "KOS-TRANS LLC", "dba_name": "", "phone": "2015550187", "phy_zip": "07026",
      "phy_city": "GARFIELD", "phy_state": "NJ", "status_code": "I", "company_officer_1": "VANCO VASILEV"}),
    # GAF 1156862 "Bergen Exteriors", Ridgefield Park 07660 -> ROCKSTAR GROUP LLC dba ALTE ROOFING, Hackettstown
    ({"gaf_id": "1156862", "name": "Bergen Exteriors", "legal_name": None, "phone": "(201) 555-0162",
      "postal_code": "07660", "city": "Ridgefield Park", "state": "NJ"},
     {"dot_number": "902", "legal_name": "ROCKSTAR GROUP LLC", "dba_name": "ALTE ROOFING", "phone": "2015550162",
      "phy_zip": "07840-5225", "phy_city": "HACKETTSTOWN", "phy_state": "NJ", "status_code": "A",
      "company_officer_1": "FAREENA SURI"}),
    # GAF 1153283 "VC Legacy Contracting", East Meadow 11554 -> JOE V TRUCKING, Baldwin (inactive)
    ({"gaf_id": "1153283", "name": "VC Legacy Contracting", "legal_name": None, "phone": "(516) 555-0183",
      "postal_code": "11554", "city": "East Meadow", "state": "NY"},
     {"dot_number": "903", "legal_name": "JOE V TRUCKING", "dba_name": "", "phone": "5165550183",
      "phy_zip": "11510-3034", "phy_city": "BALDWIN", "phy_state": "NY", "status_code": "I",
      "company_officer_1": "JOSEPH VITTINI"}),
]


async def test_phone_only_match_under_another_name_elsewhere_is_rejected():
    for contractor, row in AUDIT_PHONE_ONLY:
        conf, ev = score(contractor, row)
        assert ev["phone_match"] and ev["name_sim"] < 0.5 and not ev["same_zip"] and not ev["same_city"]
        assert conf < 0.75 and ev["phone_only"], contractor["name"]
        e = FmcsaEnricher(Settings())
        e.rows[row["dot_number"]] = row
        e.by_phone[row["phone"]].add(row["dot_number"])
        r = await e.enrich(LeadContext(contractor=contractor), http=None)
        assert r.status == EnrichmentStatus.NO_MATCH and r.contacts == []
        assert r.data["best_confidence"] < 0.75
    # Inactive registrations sink further below the bar.
    assert score(*AUDIT_PHONE_ONLY[0])[0] < score(*AUDIT_PHONE_ONLY[1])[0]


def test_phone_plus_locality_still_accepts_other_name():
    """Kept on purpose (audited as the owner's business at the same address): GAF 63229 'VMG Group',
    Roselle 07203 -> MIKE'S ROOFING INC, 288 COX ST, ROSELLE (name_sim 0.22, same ZIP + phone), and
    GAF 1137680 'JS Aldo Construction Company Inc' -> 'JSALDOCONSTRUCTIONINCCO', Paterson 07503."""
    vmg = {"gaf_id": "63229", "name": "VMG Group", "phone": "(908) 555-0129", "postal_code": "07203",
           "city": "Roselle", "state": "NJ"}
    row = {"dot_number": "904", "legal_name": "MIKE'S ROOFING INC", "phone": "9085550129", "phy_zip": "07203",
           "phy_city": "ROSELLE", "phy_state": "NJ", "status_code": "A"}
    assert score(vmg, row)[0] >= 0.75
    aldo = {"gaf_id": "1137680", "name": "JS Aldo Construction Company Inc", "phone": "(973) 555-0180",
            "postal_code": "07503", "city": "Paterson", "state": "NJ"}
    row = {"dot_number": "905", "legal_name": "JSALDOCONSTRUCTIONINCCO", "phone": "9735550180",
           "phy_zip": "07503-1915", "phy_city": "PATERSON", "phy_state": "NJ", "status_code": "A"}
    assert score(aldo, row)[0] >= 0.75


def test_inactive_same_business_is_still_accepted():
    """GAF 1116738 'B&B Contracting Corp' = inactive USDOT 'B&B CONTRACTING CORP' (phone, ZIP): the
    inactive penalty only applies when the names disagree."""
    bb = {"gaf_id": "1116738", "name": "B&B Contracting Corp", "phone": "(718) 555-0138", "postal_code": "10305",
          "city": "Staten Island", "state": "NY"}
    row = {"dot_number": "906", "legal_name": "B&B CONTRACTING CORP", "phone": "7185550138", "phy_zip": "10305",
           "phy_city": "STATEN ISLAND", "phy_state": "NY", "status_code": "I"}
    conf, ev = score(bb, row)
    assert conf >= 0.98 and ev["inactive"] and "phone_only" not in ev


async def test_ties_prefer_closer_name_then_active_latest_filing():
    """GAF 1152198 'David Anderson Construction LLC' (Watchung) shares its phone with two USDOT numbers,
    both scoring 0.99: DAVID ANDERSON CONSTRUCTION LLC (active, 2025) and DAVID ANDERSON TRUCKING CORP
    (inactive, 2020). GAF 1150506 'Pantheon Construction LLC' has two PANTHEON CONSTRUCTION LLC numbers,
    one inactive. The pick used to follow set iteration order."""
    da = {"gaf_id": "1152198", "name": "David Anderson Construction LLC", "phone": "(908) 555-0105",
          "postal_code": "07069", "city": "Watchung", "state": "NJ"}
    rows = [{"dot_number": "2504554", "legal_name": "DAVID ANDERSON TRUCKING CORP", "phone": "9085550105",
             "phy_zip": "07069", "phy_city": "WATCHUNG", "status_code": "I", "mcs150_date": "20200518"},
            {"dot_number": "4413770", "legal_name": "DAVID ANDERSON CONSTRUCTION LLC", "phone": "9085550105",
             "phy_zip": "07069-5908", "phy_city": "WATCHUNG", "status_code": "A", "mcs150_date": "20250522"}]
    pan = {"gaf_id": "1150506", "name": "Pantheon Construction LLC", "phone": "(973) 555-0160",
           "postal_code": "07506", "city": "Hawthorne", "state": "NJ"}
    pan_rows = [{"dot_number": "4390260", "legal_name": "PANTHEON CONSTRUCTION LLC", "phone": "9735550160",
                 "phy_zip": "07506-2012", "phy_city": "HAWTHORNE", "status_code": "I", "mcs150_date": "20250407"},
                {"dot_number": "2170796", "legal_name": "PANTHEON CONSTRUCTION LLC", "phone": "9735550160",
                 "phy_zip": "07506", "phy_city": "HAWTHORNE", "status_code": "A", "mcs150_date": "20251015"}]
    for contractor, rs, want in ((da, rows, "4413770"), (pan, pan_rows, "2170796")):
        for order in (rs, rs[::-1]):
            e = FmcsaEnricher(Settings())
            for r in order:
                e.rows[r["dot_number"]] = r
                e.by_phone[r["phone"]].add(r["dot_number"])
            res = await e.enrich(LeadContext(contractor=contractor), http=None)
            assert res.status == EnrichmentStatus.OK and res.data["dot_number"] == want
