"""The lead's timeline from the pipeline (offline, SQLite): activity_logs 'scraped_change' rows for material
changes and delistings, written with the audit rows and outbox events, and contacts reps create (source 'rep')
are never written by the pipeline."""

from __future__ import annotations


import pytest
from sqlalchemy import insert, select

from leadmaker.db import Repository
from leadmaker.db.repository import contact_key
from leadmaker.db.schema import activity_logs, contacts
from leadmaker.models import Contact, EnrichmentResult, EnrichmentStatus, SearchArea, SearchHit, Tier

from dbutil import cid
from fakes import fixture_contractors

AREA = SearchArea(postal_code="10013", radius_miles=25, latitude=40.7185, longitude=-74.0025)


def _timeline(repo, company_id=None):
    q = select(activity_logs).order_by(activity_logs.c.created_at, activity_logs.c.id)
    if company_id:
        q = q.where(activity_logs.c.company_id == company_id)
    with repo.engine.connect() as conn:
        return [dict(r._mapping) for r in conn.execute(q)]


def _people(*people, source="bbb", status=EnrichmentStatus.OK):
    """people: names, or (name, email) pairs."""
    pairs = [p if isinstance(p, tuple) else (p, None) for p in people]
    return EnrichmentResult(source=source, status=status, confidence=0.9, source_urls=["https://bbb.example"],
                            contacts=[Contact(name=n, title="Owner", email=e, source=source, confidence=0.8)
                                      for n, e in pairs])


def _read(repo, cs):
    run = repo.start_run("gaf_ingest", {})
    repo.upsert_contractors(cs, run_id=run)
    repo.record_search_hits(run, AREA, [SearchHit(company_id=cid(repo, c.gaf_id), distance_miles=1.0, rank=i + 1)
                                        for i, c in enumerate(cs)])
    return run


def test_material_listing_changes_are_on_the_timeline_and_crawls_are_not(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs, run_id=1)
    assert _timeline(repo) == []  # first sight is not a change
    repo.upsert_contractors(cs, run_id=2)
    assert _timeline(repo) == []  # same listing
    cs[1].review_count += 3  # visible, audited, not material
    repo.upsert_contractors(cs, run_id=3)
    assert _timeline(repo) == []

    old_tier, old_rating = cs[0].tier.value, cs[0].rating
    cs[0].tier = Tier.NONE if cs[0].tier != Tier.NONE else Tier.CERTIFIED
    cs[0].rating = (old_rating or 4.0) - 0.5
    cs[0].review_count += 1
    repo.upsert_contractors(cs, run_id=4)
    (row,) = _timeline(repo)
    assert row["company_id"] == cid(repo, cs[0].gaf_id)
    assert (row["action_type"], row["actor_type"], row["user_id"], row["note_text"]) == (
        "scraped_change", "pipeline", None, None)
    assert row["field_diff"] == {"fields": ["rating", "tier"], "from": {"rating": old_rating, "tier": old_tier},
                                 "to": {"rating": cs[0].rating, "tier": cs[0].tier.value}, "run_id": 4}


def test_company_field_updates_use_column_names_and_skip_non_material_fields(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    company = cid(repo, cs[0].gaf_id)
    repo.update_companies({company: {"county_fips": "36061"}}, run_id=5)
    assert _timeline(repo) == []
    repo.set_website(company, "https://roofer.example", "google_places", run_id=6)
    repo.set_website(company, "https://roofer.example", "google_places", run_id=7)  # unchanged
    (row,) = _timeline(repo)
    assert row["field_diff"] == {"fields": ["website_url"], "from": {"website_url": None},
                                 "to": {"website_url": "https://roofer.example"}, "run_id": 6}


def test_contact_changes_are_on_the_timeline(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    company = cid(repo, cs[0].gaf_id)
    r1, r2, r3 = (repo.start_run("enrich", {}) for _ in range(3))
    repo.save_enrichment(company, _people("Pat Owner", "Sam Manager"), run_id=r1)
    repo.save_enrichment(company, _people("Pat Owner", "Sam Manager"), run_id=r2)  # same people
    repo.save_enrichment(company, _people(("Pat Owner", "pat@roofer.example")), run_id=r3)  # new email, Sam gone
    diffs = [r["field_diff"] for r in _timeline(repo, company)]
    assert diffs == [
        {"fields": ["contacts"], "from": {"contacts": []}, "run_id": r1,
         "to": {"contacts": [{"name": "Pat Owner", "title": "Owner"}, {"name": "Sam Manager", "title": "Owner"}]}},
        {"fields": ["contacts"], "run_id": r3,
         "from": {"contacts": [{"name": "Pat Owner", "title": "Owner"}, {"name": "Sam Manager", "title": "Owner"}]},
         "to": {"contacts": [{"name": "Pat Owner", "title": "Owner", "email": "pat@roofer.example"}]}},
    ]


def test_delisting_is_on_the_timeline_and_published_with_delisted_true(repo):
    cs = fixture_contractors()
    _read(repo, cs)
    run = _read(repo, cs[1:])
    gone = cid(repo, cs[0].gaf_id)
    n = len(repo.outbox("lead.updated"))
    versions = {c["company_id"]: c["version"] for c in repo.get_companies()}
    assert repo.record_delisted(run, AREA, [c.gaf_id for c in cs[1:]]) == [gone]
    # a new version, so the profile cached under the old one (without this timeline row) is never served
    assert {c["company_id"]: c["version"] for c in repo.get_companies()} == {**versions, gone: versions[gone] + 1}

    (row,) = _timeline(repo)
    assert row["company_id"] == gone and row["actor_type"] == "pipeline" and row["user_id"] is None
    assert row["field_diff"] == {"fields": ["delisted"], "from": {"delisted": False}, "to": {"delisted": True},
                                 "area": "10013@25.0mi", "run_id": run}
    (ev,) = repo.outbox("lead.updated")[n:]
    assert ev["company_id"] == gone
    assert ev["payload"] == {"company_id": gone, "actor_type": "pipeline", "actor_id": None, "version": 2,
                             "run_id": run, "fields": ["delisted"], "material": False, "delisted": True,
                             "area": "10013@25.0mi"}
    assert [e["action"] for e in repo.audit_log(run_id=run)] == ["delisted"]


@pytest.mark.parametrize("step", ["listing", "delisting"])
def test_timeline_rows_roll_back_with_their_change(repo, monkeypatch, step):
    """Same transaction as the audit rows: when the outbox write fails, neither is kept."""
    cs = fixture_contractors()
    run = _read(repo, cs)
    before = (len(repo.audit_log(limit=10_000)), _timeline(repo))

    def boom(*a, **kw):
        raise RuntimeError("outbox down")

    monkeypatch.setattr(Repository, "_lead_updated", staticmethod(boom))
    with pytest.raises(RuntimeError):
        if step == "listing":
            cs[0].tier = Tier.NONE if cs[0].tier != Tier.NONE else Tier.CERTIFIED
            repo.upsert_contractors(cs, run_id=run + 1)
        else:
            repo.record_delisted(run + 1, AREA, [c.gaf_id for c in cs[1:]])
    assert (len(repo.audit_log(limit=10_000)), _timeline(repo)) == before


# ----------------------------------------------------------------------------- rep contacts
def _rep_contacts(repo, company):
    """Contacts a rep added through the CRM Write Service: one without a source_key, and two whose keys collide
    with what the pipeline computes for a source named 'rep' and for BBB."""
    with repo.engine.begin() as conn:
        for name, email, key in (("Rita Rep-Added", None, None),
                                 ("Pat Owner", "pat@rep.example", contact_key(company, "Pat Owner", "rep")),
                                 ("Sam Manager", None, contact_key(company, "Sam Manager", "bbb"))):
            conn.execute(insert(contacts).values(company_id=company, name=name, title="Owner", email=email,
                                                 source="rep", source_key=key, confidence=1.0))


def _contact_rows(repo, company):
    with repo.engine.connect() as conn:
        return sorted((dict(r._mapping) for r in conn.execute(select(contacts).where(
            contacts.c.company_id == company, contacts.c.source == "rep"))), key=lambda r: r["name"])


def test_pipeline_never_deletes_or_modifies_contacts_reps_created(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    company = cid(repo, cs[0].gaf_id)
    _rep_contacts(repo, company)
    before = _contact_rows(repo, company)
    version = repo.get_companies([company])[0]["version"]

    repo.save_enrichment(company, _people("Pat Owner", ("Sam Manager", "sam@bbb.example")))  # BBB's Pat: a new row
    repo.save_enrichment(company, _people())  # BBB's full answer is now nobody
    repo.save_enrichment(company, _people(("Pat Owner", "other@x.example"), "Nora New", source="rep"))  # named 'rep'
    repo.save_enrichment(company, _people(source="rep", status=EnrichmentStatus.NO_MATCH))
    for src in ("website_crawl", "llm_extract"):
        repo.save_enrichment(company, _people(source=src))

    assert _contact_rows(repo, company) == before
    with repo.engine.connect() as conn:
        assert conn.execute(select(contacts.c.source).where(contacts.c.company_id == company)).scalars().all() == [
            "rep", "rep", "rep"]
    assert [(e["action"], e["changes"]["source"]) for e in reversed(repo.audit_log())
            if e["entity_type"] == "contact"] == [("created", [None, "bbb"]), ("removed", ["bbb", None])]
    assert repo.get_companies([company])[0]["version"] == version + 2  # BBB's Pat came and went
    assert [r["field_diff"]["to"]["contacts"] for r in _timeline(repo, company)] == [
        [{"name": "Pat Owner", "title": "Owner"}], []]


def test_rep_contacts_are_kept_in_the_lead_record(repo):
    cs = fixture_contractors()
    _read(repo, cs)
    company = cid(repo, cs[0].gaf_id)
    _rep_contacts(repo, company)
    lead = next(l for l in repo.lead_records("10013", 25) if l["company_id"] == company)
    assert {c["name"] for c in lead["contacts"] if c["source"] == "rep"} == {"Rita Rep-Added", "Pat Owner",
                                                                            "Sam Manager"}
