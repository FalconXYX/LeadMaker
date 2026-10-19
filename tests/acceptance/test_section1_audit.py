"""Section 1 acceptance -- Audit Logging.

Requirement (docs/OpeningRequirements.MD, Section 1):
  "All data additions, updates, and generated tags are stored with timestamped logs."
Each pipeline write lands in audit_events with the run that made it, a timestamp, and field-level
changes ({field: [old, new]}) -- for contractor listings, profiles, enrichments, contacts, tags and
delistings. Re-running with no change logs nothing.
"""

from __future__ import annotations

import json
from datetime import timedelta

from leadmaker.db.repository import as_utc, utcnow
from leadmaker.models import Contact
from leadmaker.pipeline.enrich import EnrichOptions, run_enrich
from leadmaker.pipeline.tag import run_tagging

from dbutil import cid, leads_by_gaf, with_gaf
from fakes import CountingSource, FakeGaf, PeopleSource, area_results, gid, offline_settings



def _events(repo, run_id):
    return with_gaf(repo, sorted(repo.audit_log(run_id=run_id, limit=10_000), key=lambda e: e["id"]))


async def test_every_pipeline_write_is_logged_with_run_id_timestamp_and_field_diffs(
    repo, scrape, use_enrichers, tmp_path
):
    """Additions, updates, generated tags and delistings each leave a timestamped, run-attributed event
    that says exactly which fields changed from what to what."""
    started = utcnow() - timedelta(seconds=1)
    fake = FakeGaf({"10013": area_results(range(3))})

    # Additions: listing + profile + reviews.
    s1 = await scrape(fake, postal_code="10013", radius_miles=25)
    ev1 = _events(repo, s1.run_id)
    created = [e for e in ev1 if e["entity_type"] == "company"]
    assert sorted(e["gaf_id"] for e in created) == [gid(0), gid(1), gid(2)]
    assert all(e["action"] == "created" and e["changes"]["name"][0] is None for e in created)
    assert {(e["entity_type"], e["action"]) for e in ev1} >= {("profile", "created"), ("reviews", "created")}
    assert all(started <= as_utc(e["at"]) <= utcnow() for e in ev1)

    # Update: one contractor's rating and phone change; nothing else is logged.
    fake.areas["10013"] = area_results(range(3))
    fake.areas["10013"][1]["raw"].update(gaf_rating=3.9, gaf_phone="(718) 555-0123")
    old = leads_by_gaf(repo, [gid(1)])[0]
    s2 = await scrape(fake, postal_code="10013", radius_miles=25)
    (upd,) = _events(repo, s2.run_id)
    assert (upd["entity_type"], upd["action"], upd["gaf_id"]) == ("company", "updated", gid(1))
    assert upd["changes"] == {"rating": [old["rating"], 3.9], "phone": [old["phone"], "(718) 555-0123"]}

    # Enrichments and discovered contacts.
    PeopleSource.people = {gid(0): [Contact(name="Ana Owner", title="Owner", source="bbb", confidence=0.8)]}
    use_enrichers(CountingSource, PeopleSource)
    e1 = await run_enrich(offline_settings(), repo, EnrichOptions())
    ev = _events(repo, e1.run_id)
    enr = [e for e in ev if e["entity_type"] == "enrichment"]
    assert sorted(e["entity_id"] for e in enr) == sorted(
        f"{cid(repo, gid(i))}:{s}" for i in range(3) for s in ("osm", "bbb"))
    assert {e["changes"]["status"][1] for e in enr} == {"ok", "no_match"}
    (contact,) = [e for e in ev if e["entity_type"] == "contact"]
    assert contact["gaf_id"] == gid(0)
    assert contact["changes"] == {"name": [None, "Ana Owner"], "title": [None, "Owner"], "source": [None, "bbb"]}

    # An enrichment whose data changed: the changed keys are named.
    fake.areas["10013"][2]["raw"]["gaf_phone"] = "(973) 555-0100"
    await scrape(fake, postal_code="10013", radius_miles=25)
    e2 = await run_enrich(offline_settings(), repo, EnrichOptions())
    (changed,) = [e for e in _events(repo, e2.run_id) if e["entity_type"] == "enrichment"]
    assert changed["entity_id"] == f"{cid(repo, gid(2))}:osm" and changed["action"] == "updated"
    assert changed["changes"]["data_keys_changed"] == [None, ["seen_phone"]]

    # Generated tags: created on the first tagging run, diffed on later ones.
    t1 = run_tagging(repo, "10013", 25)
    tags1 = [e for e in _events(repo, t1["run_id"]) if e["entity_type"] == "tags"]
    assert len(tags1) == 3 and all(e["action"] == "created" for e in tags1)
    assert all("gaf_tier=" + leads_by_gaf(repo, [e["gaf_id"]])[0]["tier"] in e["changes"]["tags_added"][1]
               for e in tags1)
    rules = tmp_path / "rules.json"
    rules.write_text(json.dumps([{"key": "focus_list", "priority_boost": 10, "when": {"field": "gaf_id", "eq": gid(0)}}]))
    t2 = run_tagging(repo, "10013", 25, rules_path=rules)
    (tag_upd,) = [e for e in _events(repo, t2["run_id"]) if e["entity_type"] == "tags"]
    assert tag_upd["gaf_id"] == gid(0) and tag_upd["action"] == "updated"
    assert tag_upd["changes"]["tags_added"] == [None, ["focus_list=True"]]
    before, after = tag_upd["changes"]["priority_score"]
    assert after == min(100.0, before + 10)

    # Delisting after a complete read that no longer lists one contractor.
    fake.areas["10013"] = fake.areas["10013"][:2] + area_results([3])  # 3 results; gid(2) gone, gid(3) new
    s3 = await scrape(fake, postal_code="10013", radius_miles=25, fetch_profiles=False)
    ev3 = _events(repo, s3.run_id)
    assert [(e["action"], e["gaf_id"]) for e in ev3 if e["entity_type"] == "area"] == [("delisted", gid(2))]
    assert [(e["action"], e["gaf_id"]) for e in ev3 if e["entity_type"] == "company"] == [("created", gid(3))]

    # No change, no events.
    t3 = run_tagging(repo, "10013", 25, rules_path=rules)
    assert [e for e in _events(repo, t3["run_id"]) if e["gaf_id"] != gid(3)] == []
    s4 = await scrape(fake, postal_code="10013", radius_miles=25, fetch_profiles=False)
    assert _events(repo, s4.run_id) == []


def test_audit_log_is_queryable_per_lead_and_since(repo):
    """The log answers 'what changed for this lead' and 'what changed since the last poll'."""
    from fakes import fixture_contractors

    cs = fixture_contractors()
    repo.upsert_contractors(cs, run_id=1)
    cutoff = utcnow()
    cs[0].review_count += 3
    repo.upsert_contractors(cs, run_id=2)
    mine = repo.audit_log(gaf_id=cs[0].gaf_id)
    assert [e["action"] for e in mine] == ["updated", "created"]  # newest first
    recent = with_gaf(repo, repo.audit_log(since=cutoff))
    assert [(e["gaf_id"], e["run_id"]) for e in recent] == [(cs[0].gaf_id, 2)]
    assert recent[0]["changes"]["review_count"][1] == recent[0]["changes"]["review_count"][0] + 3
