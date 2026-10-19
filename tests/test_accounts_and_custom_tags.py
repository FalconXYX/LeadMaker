"""CRM account import/matching and user-defined tag rules (offline)."""

import json
from datetime import timedelta
from pathlib import Path

import pytest

from leadmaker.accounts import account_status, import_accounts
from leadmaker.custom_tags import RuleError, apply_rules, evaluate, load_rules
from leadmaker.db import Repository
from leadmaker.db.repository import utcnow
from leadmaker.models import SearchArea, SearchHit
from leadmaker.pipeline.tag import run_tagging
from leadmaker.sources.gaf.parse import parse_coveo_result

FIX = Path(__file__).parent / "fixtures"


@pytest.fixture
def repo(tmp_path):
    r = Repository(f"sqlite:///{tmp_path / 'acct.db'}")
    cs = [parse_coveo_result(x) for x in json.loads((FIX / "coveo_search_response.json").read_text())["results"]]
    r.upsert_contractors(cs)
    run = r.start_run("gaf_ingest", {})
    area = SearchArea(postal_code="10013", radius_miles=25, latitude=40.7, longitude=-74.0)
    r.record_search_hits(run, area, [SearchHit(company_id=r.company_id(c.gaf_id), distance_miles=1, rank=i + 1)
                                     for i, c in enumerate(cs)])
    return r


def _csv(tmp_path, text):
    p = tmp_path / "accounts.csv"
    p.write_text(text)
    return p


def test_import_matches_by_phone_and_by_name_locality(repo, tmp_path):
    p = _csv(tmp_path, (
        "Customer Number,Account Name,Main Phone,Zip,City,Status,Sales Rep,TTM Sales,Last Order Date\n"
        "A1,Jersey Roofing,201-982-2718,07026,Garfield,Active,Dana,\"$612,000\",2026-09-30\n"
        "A2,Golovin Roofing,,11358,Flushing,Inactive,Lee,12000,2024-01-15\n"
        "A3,Totally Unknown Co,555-000-0000,99999,Nowhere,Active,Kim,5000,2026-10-01\n"
    ))
    out = import_accounts(repo, p)
    assert out["rows"] == 3 and out["matched"] == 2
    assert out["headers_mapped"]["name"] == "Account Name"
    # The import is a logged run, and the matched companies' account_status is set straight away.
    run = repo.list_runs(1)[0]
    assert (run["id"], run["kind"], run["status"]) == (out["run_id"], "crm_import", "succeeded")
    assert [e["entity_type"] for e in repo.audit_log(run_id=out["run_id"]) if e["company_id"] is None] == ["accounts"]
    assert out["account_status_changed"] == 2
    statuses = {r["name"]: r["account_status"] for r in repo.get_companies()}
    assert statuses["Jersey Roofing LLC"] == "existing_customer" and statuses["Gemz Construction Corp"] == "prospect"
    tagged = run_tagging(repo, "10013", 25)
    assert tagged["account_status"]["existing_customer"] == 1
    assert tagged["account_status"]["lapsed_customer"] == 1
    rows = {r["name"]: r for r in repo.get_companies()}
    jersey_tags = {t["key"]: t for t in rows["Jersey Roofing LLC"]["tags"]}
    assert jersey_tags["account_status"]["value"] == "existing_customer"
    assert jersey_tags["account_spend_band"]["value"] == "high"
    assert {t["key"]: t for t in rows["Gemz Construction Corp"]["tags"]}["account_status"]["value"] == "prospect"
    lead = next(l for l in repo.lead_records("10013", 25) if l["name"] == "Jersey Roofing LLC")
    assert lead["account"]["account_id"] == "A1" and lead["account"]["match_method"] == "phone"


def test_account_status_rules():
    now = utcnow()
    assert account_status(None) == "prospect"
    assert account_status({"status": "active", "last_order_at": now}) == "existing_customer"
    assert account_status({"status": "active", "last_order_at": now - timedelta(days=400)}) == "lapsed_customer"
    assert account_status({"status": "DNC"}) == "do_not_contact"


def test_import_requires_name_column(repo, tmp_path):
    with pytest.raises(ValueError):
        import_accounts(repo, _csv(tmp_path, "phone,zip\n1,2\n"))


def test_custom_rules_evaluate_and_boost(repo, tmp_path):
    rules = [
        {"key": "big_reviewer", "label": "200+ reviews", "priority_boost": 7,
         "when": {"field": "review_count", "gte": 200}},
        {"key": "nj_me", "when": {"all": [{"field": "state", "eq": "NJ"}, {"field": "tier", "eq": "master_elite"}]}},
        {"key": "flushing", "when": {"field": "city", "in": ["Flushing"]}},
        {"key": "mentions_jersey", "when": {"text_contains": ["jersey roofing"]}},
        {"key": "no_site", "when": {"not": {"field": "website", "exists": True}}},
    ]
    rp = tmp_path / "rules.json"
    rp.write_text(json.dumps(rules))
    loaded = load_rules(rp)
    stats = run_tagging(repo, "10013", 25, rules_path=rp)
    assert stats["custom_rules"] == 5 and stats["leads_matching_custom_rules"] == stats["tagged"]
    rows = {r["name"]: r for r in repo.get_companies()}
    jersey = {t["key"] for t in rows["Jersey Roofing LLC"]["tags"]}
    assert {"big_reviewer", "nj_me", "mentions_jersey", "no_site"} <= jersey
    assert "flushing" in {t["key"] for t in rows["Golovin Roofing LLC"]["tags"]}
    tags, boost = apply_rules({"review_count": 300, "state": "NY"}, loaded)
    assert boost == 7 and "big_reviewer" in {t["key"] for t in tags}
    assert evaluate({"field": "enrichment.nyc_dcwp.status", "eq": "ok"},
                    {"enrichment": {"nyc_dcwp": {"status": "ok"}}})


def test_bad_rules_rejected(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps([{"key": "x", "when": {"field": "city"}}]))
    with pytest.raises(RuleError):
        load_rules(p)
