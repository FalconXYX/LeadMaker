"""Section 2 duties of the pipeline on the companies schema, offline on SQLite: company identity through
company_source_ids, outbox events in the same transaction as each change, material changes and
updated_in_last_poll, override safety (the pipeline writes scraped values only), and the schema guards."""

from __future__ import annotations

import sqlite3
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, insert, select, update

from leadmaker.db import Repository
from leadmaker.db.repository import PollBaseline, SchemaError, normalize_url, utcnow
from leadmaker.db.schema import (
    companies,
    company_source_ids,
    contacts,
    field_overrides,
    lead_allocations,
    lead_rep_state,
    outbox_events,
)
from leadmaker.models import Contact, ContractorProfile, EnrichmentResult, EnrichmentStatus, SearchArea, SearchHit, Tier

from dbutil import add_user, cid
from fakes import fixture_contractors

FIX = Path(__file__).parent / "fixtures"
AREA = SearchArea(postal_code="10013", radius_miles=25, latitude=40.7185, longitude=-74.0025)


def _poll(repo, cs, since=None, complete=True):
    """One GAF area read: upsert, hits, finish (complete reads pass a PollBaseline)."""
    run = repo.start_run("gaf_ingest", {"postal_code": "10013", "radius_miles": 25})
    repo.upsert_contractors(cs, run_id=run)
    repo.record_search_hits(run, AREA, [SearchHit(company_id=cid(repo, c.gaf_id), distance_miles=1.0, rank=i + 1)
                                        for i, c in enumerate(cs)])
    repo.finish_run(run, "succeeded" if complete else "partial", {},
                    poll=PollBaseline(since=since) if complete else None)
    return run


def _row(repo, gaf_id):
    return repo.get_companies([cid(repo, gaf_id)])[0]


def _finished(repo, run_id):
    return next(r for r in repo.list_runs(100) if r["id"] == run_id)["finished_at"]


# --------------------------------------------------------------------------------- identity
def test_gaf_ids_resolve_to_stable_company_ids(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    ids = repo.company_ids([c.gaf_id for c in cs])
    assert len(set(ids.values())) == len(cs)
    repo.upsert_contractors(cs)  # a re-read never mints new companies
    assert repo.company_ids([c.gaf_id for c in cs]) == ids
    with repo.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(companies)).scalar() == len(cs)
        links = conn.execute(select(company_source_ids)).all()
    assert {(r.source, r.external_id, r.company_id) for r in links} == {("gaf", g, c) for g, c in ids.items()}
    assert repo.company_id("no-such-id") is None


def test_a_listing_repeated_in_one_batch_is_one_company(repo):
    cs = fixture_contractors()
    twice = [*cs, cs[0].model_copy(update={"review_count": cs[0].review_count + 1})]
    assert repo.upsert_contractors(twice) == {"new": len(cs), "changed": 0, "unchanged": 0}
    assert _row(repo, cs[0].gaf_id)["review_count"] == cs[0].review_count + 1  # the last listing wins


def test_new_listing_without_coordinates_is_not_stored(repo):
    cs = fixture_contractors()
    cs[0] = cs[0].model_copy(update={"latitude": None, "longitude": None})
    counts = repo.upsert_contractors(cs)
    assert counts == {"new": len(cs) - 1, "changed": 0, "unchanged": 0, "no_location": 1}
    assert repo.company_id(cs[0].gaf_id) is None
    # A known company that loses its coordinates in a later read keeps the stored location.
    cs[1] = cs[1].model_copy(update={"latitude": None, "longitude": None, "review_count": cs[1].review_count + 1})
    repo.upsert_contractors(cs)
    assert _row(repo, cs[1].gaf_id)["latitude"] == fixture_contractors()[1].latitude


# ----------------------------------------------------------------------------------- outbox
def test_every_company_change_publishes_one_lead_updated_event(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs, run_id=11)
    events = repo.outbox("lead.updated")
    assert len(events) == len(cs)
    first = events[0]
    assert first["company_id"] == first["payload"]["company_id"] and first["published_at"] is None
    assert first["payload"] | {"company_id": None} == {
        "company_id": None, "actor_type": "pipeline", "actor_id": None, "version": 1, "run_id": 11,
        "fields": ["created"], "material": True}

    repo.upsert_contractors(cs, run_id=12)  # nothing changed -> nothing published
    assert len(repo.outbox("lead.updated")) == len(cs)

    cs[0].review_count += 3
    repo.upsert_contractors(cs, run_id=13)
    (ev,) = repo.outbox("lead.updated")[len(cs):]
    assert ev["company_id"] == cid(repo, cs[0].gaf_id)
    assert ev["payload"]["fields"] == ["review_count"] and ev["payload"]["material"] is False


def test_profile_and_tag_changes_publish_lead_updated(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    company = cid(repo, cs[0].gaf_id)
    n = len(repo.outbox("lead.updated"))
    repo.save_profile(company, ContractorProfile(gaf_id=cs[0].gaf_id, legal_name="Renamed LLC"), run_id=3)
    tags = [{"key": "k", "value": 1, "reason": "r", "source": "s"}]
    repo.save_tags(company, tags, "growth", 50, run_id=3)
    repo.save_profile(company, ContractorProfile(gaf_id=cs[0].gaf_id, legal_name="Renamed LLC"), run_id=4)
    repo.save_tags(company, tags, "growth", 50, run_id=4)  # nothing visible changed the second time
    events = repo.outbox("lead.updated")[n:]
    assert [(e["company_id"], e["payload"]["run_id"], e["payload"]["material"]) for e in events] == [
        (company, 3, False), (company, 3, False)]
    assert "legal_name" in events[0]["payload"]["fields"]
    assert events[1]["payload"]["fields"] == ["priority_score", "segment", "tags"]
    assert events[1]["payload"]["version"] == _row(repo, cs[0].gaf_id)["version"]


def test_run_completed_lists_changed_companies(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    run = repo.start_run("tag", {"postal_code": "10013"})
    company = cid(repo, cs[0].gaf_id)
    repo.save_tags(company, [{"key": "k", "value": 1, "reason": "r", "source": "s"}], "growth", 50, run_id=run)
    repo.finish_run(run, "succeeded", {"tagged": 1})
    (done,) = repo.outbox("pipeline.run_completed")
    assert done["company_id"] is None
    assert done["payload"] == {"actor_type": "pipeline", "actor_id": None, "run_id": run, "kind": "tag",
                               "status": "succeeded", "complete": False, "changed_companies": 1,
                               "company_ids": [company], "company_ids_truncated": False}


def test_events_roll_back_with_their_change(repo, monkeypatch):
    """Same transaction: when the audit write fails, neither the company change nor its event is kept."""
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    before = len(repo.outbox())
    cs[0].tier = Tier.NONE

    def boom(*a, **kw):
        raise RuntimeError("audit down")

    monkeypatch.setattr(Repository, "_audit", staticmethod(boom))
    with pytest.raises(RuntimeError):
        repo.upsert_contractors(cs)
    assert len(repo.outbox()) == before
    assert _row(repo, cs[0].gaf_id)["tier"] == fixture_contractors()[0].tier.value


# ------------------------------------------------------------------- material changes / poll
def test_material_fields_set_last_material_change_at(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    created = _row(repo, cs[0].gaf_id)["last_material_change_at"]
    assert created is not None

    cs[0].review_count += 1  # visible, not material
    repo.upsert_contractors(cs)
    assert _row(repo, cs[0].gaf_id)["last_material_change_at"] == created

    cs[0].tier = Tier.NONE if cs[0].tier != Tier.NONE else Tier.CERTIFIED
    repo.upsert_contractors(cs)
    assert _row(repo, cs[0].gaf_id)["last_material_change_at"] > created
    assert repo.outbox("lead.updated")[-1]["payload"]["material"] is True

    company = cid(repo, cs[1].gaf_id)
    before = _row(repo, cs[1].gaf_id)["last_material_change_at"]
    repo.set_website(company, "https://example-roofing.com", "website_discovery", run_id=4)
    row = _row(repo, cs[1].gaf_id)
    assert row["website"] == "https://example-roofing.com" and row["last_material_change_at"] > before
    assert repo.audit_log(run_id=4)[0]["changes"]["website"] == [None, "https://example-roofing.com"]
    repo.set_website(company, "https://example-roofing.com", "website_discovery", run_id=5)  # same -> no-op
    assert repo.audit_log(run_id=5) == []


def test_updated_in_last_poll_follows_complete_reads_only(repo):
    cs = fixture_contractors()
    first = _poll(repo, cs)  # first complete read: everything is new
    assert all(r["updated_in_last_poll"] for r in repo.get_companies())
    assert repo.list_runs(1)[0]["stats"]["poll"] == {"covered": len(cs), "updated_in_last_poll": len(cs),
                                                     "flag_changed": 0}

    cs[0].tier = Tier.NONE if cs[0].tier != Tier.NONE else Tier.CERTIFIED  # material
    cs[1].review_count += 4  # not material
    _poll(repo, cs, since=_finished(repo, first))
    flags = {r["gaf_id"]: r["updated_in_last_poll"] for r in repo.get_companies()}
    assert flags == {c.gaf_id: c.gaf_id == cs[0].gaf_id for c in cs}
    (done,) = [e for e in repo.outbox("pipeline.run_completed") if e["payload"]["run_id"] == repo.list_runs(1)[0]["id"]]
    assert done["payload"]["complete"] is True and cid(repo, cs[2].gaf_id) in done["payload"]["company_ids"]

    # A cut-short read changes data but never the flags.
    cs[2].tier = Tier.NONE if cs[2].tier != Tier.NONE else Tier.CERTIFIED
    _poll(repo, cs, complete=False)
    assert {r["gaf_id"]: r["updated_in_last_poll"] for r in repo.get_companies()} == flags
    assert "poll" not in repo.list_runs(1)[0]["stats"]


def test_failed_run_never_marks_the_poll(repo):
    cs = fixture_contractors()
    run = repo.start_run("gaf_ingest", {})
    repo.upsert_contractors(cs, run_id=run)
    with repo.engine.begin() as conn:
        conn.execute(update(companies).values(updated_in_last_poll=False))
    repo.finish_run(run, "failed", {}, error="boom", poll=PollBaseline(since=None))
    assert not any(r["updated_in_last_poll"] for r in repo.get_companies())
    assert repo.outbox("pipeline.run_completed")[-1]["payload"]["complete"] is False


# ------------------------------------------------------------------------------- contacts
def _people(*names, source="bbb"):
    return EnrichmentResult(source="bbb", status=EnrichmentStatus.OK, confidence=0.9, data={},
                            source_urls=["https://bbb.example"],
                            contacts=[Contact(name=n, title="Owner", source=source, confidence=0.8) for n in names])


def test_contact_changes_bump_the_company_version_and_are_material(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    company = cid(repo, cs[0].gaf_id)
    v0 = _row(repo, cs[0].gaf_id)
    n_events = len(repo.outbox("lead.updated"))
    r1, r2, r3 = (repo.start_run("enrich", {}) for _ in range(3))

    repo.save_enrichment(company, _people("Pat Owner", "Sam Manager"), run_id=r1)
    v1 = _row(repo, cs[0].gaf_id)
    assert v1["version"] == v0["version"] + 1 and v1["last_material_change_at"] > v0["last_material_change_at"]
    ev = repo.outbox("lead.updated")[-1]
    assert len(repo.outbox("lead.updated")) == n_events + 1
    assert ev["payload"]["fields"] == ["contacts"] and ev["payload"]["version"] == v1["version"]
    with repo.engine.connect() as conn:
        keys = {r.name: r.source_key for r in conn.execute(select(contacts.c.name, contacts.c.source_key))}
    created = {e["entity_id"] for e in repo.audit_log(run_id=r1) if e["entity_type"] == "contact"}
    assert created == set(keys.values())  # contacts are audited under their source_key

    repo.save_enrichment(company, _people("Pat Owner", "Sam Manager"), run_id=r2)  # same people: nothing changes
    assert _row(repo, cs[0].gaf_id)["version"] == v1["version"]
    assert len(repo.outbox("lead.updated")) == n_events + 1

    repo.save_enrichment(company, _people("Pat Owner"), run_id=r3)  # BBB no longer lists Sam
    assert _row(repo, cs[0].gaf_id)["version"] == v1["version"] + 1
    assert [(e["action"], e["entity_id"]) for e in repo.audit_log(run_id=r3)
            if e["entity_type"] == "contact"] == [("removed", keys["Sam Manager"])]


def test_contact_rank_changes_bump_the_version_but_are_not_material(repo):
    """A new confidence or source URL bumps the contact's version and can move the target contact, so the
    company's version (the profile cache key) follows it; it is not a material change."""
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    company = cid(repo, cs[0].gaf_id)
    repo.save_enrichment(company, _people("Pat Owner"))
    before = _row(repo, cs[0].gaf_id)
    n = len(repo.outbox("lead.updated"))
    run = repo.start_run("enrich", {})
    moved = _people("Pat Owner")
    moved.contacts[0].confidence, moved.contacts[0].source_url = 0.95, "https://bbb.example/pat"
    repo.save_enrichment(company, moved, run_id=run)
    after = _row(repo, cs[0].gaf_id)
    assert after["version"] == before["version"] + 1
    assert after["last_material_change_at"] == before["last_material_change_at"]
    (ev,) = repo.outbox("lead.updated")[n:]
    assert ev["payload"] | {"company_id": None} == {
        "company_id": None, "actor_type": "pipeline", "actor_id": None, "version": after["version"], "run_id": run,
        "fields": ["contacts"], "material": False}
    assert [e for e in repo.audit_log(run_id=run) if e["entity_type"] == "contact"] == []  # audit keeps facts only
    repo.save_enrichment(company, moved, run_id=run)
    assert _row(repo, cs[0].gaf_id)["version"] == after["version"] and len(repo.outbox("lead.updated")) == n + 1


def test_contact_a_rep_edited_survives_when_its_source_drops_it(repo):
    """Override safety: pruning a contact would cascade-delete the rep's field_overrides, so it is kept."""
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    company = cid(repo, cs[0].gaf_id)
    repo.save_enrichment(company, _people("Pat Owner", "Sam Manager"))
    rep = add_user(repo)
    with repo.engine.begin() as conn:
        sam = conn.execute(select(contacts.c.id).where(contacts.c.name == "Sam Manager")).scalar()
        conn.execute(insert(field_overrides).values(company_id=company, contact_id=sam, field="phone",
                                                    value="(212) 555-0100", user_id=rep))
    run = repo.start_run("enrich", {})
    repo.save_enrichment(company, _people("Pat Owner"), run_id=run)
    with repo.engine.connect() as conn:
        names = set(conn.execute(select(contacts.c.name)).scalars())
        overrides = conn.execute(select(func.count()).select_from(field_overrides)).scalar()
    assert names == {"Pat Owner", "Sam Manager"} and overrides == 1
    (ev,) = [e for e in repo.audit_log(run_id=run) if e["entity_type"] == "contact"]
    assert ev["action"] == "retained"


def test_pipeline_never_overwrites_crm_owned_data(repo):
    cs = fixture_contractors()
    _poll(repo, cs)
    company = cid(repo, cs[0].gaf_id)
    manager, rep = add_user(repo, "Mo Manager", role="manager"), add_user(repo, "Rae Rep")
    checked = utcnow() - timedelta(hours=1)
    with repo.engine.begin() as conn:
        conn.execute(insert(lead_allocations).values(company_id=company, rep_id=rep, allocated_by=manager))
        conn.execute(insert(lead_rep_state).values(company_id=company, user_id=rep, checked_at=checked))
        conn.execute(update(companies).where(companies.c.id == company).values(
            assigned_rep_id=rep, custom_fields={"crew_size": 4}, team_last_checked_at=checked))
    cs[0].tier = Tier.NONE if cs[0].tier != Tier.NONE else Tier.CERTIFIED
    cs[0].review_count += 7
    _poll(repo, cs)
    repo.save_profile(company, ContractorProfile(gaf_id=cs[0].gaf_id, legal_name="Renamed LLC"))
    repo.save_tags(company, [{"key": "k", "value": 1, "reason": "r", "source": "s"}], "growth", 61.25,
                   account_status="existing_customer")
    row = _row(repo, cs[0].gaf_id)
    assert (row["assigned_rep_id"], row["custom_fields"]) == (rep, {"crew_size": 4})
    assert row["team_last_checked_at"] is not None
    assert row["priority_score"] == 61.2  # NUMERIC(4,1)
    assert row["account_status"] == "existing_customer"
    with repo.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(lead_allocations)).scalar() == 1
        assert conn.execute(select(lead_rep_state.c.checked_at)).scalar() is not None


# --------------------------------------------------------------------------------- guards
def test_section1_sqlite_file_is_refused_untouched(tmp_path):
    legacy = tmp_path / "leadmaker.db"
    con = sqlite3.connect(legacy)
    con.executescript((FIX / "section1_schema.sql").read_text())
    con.close()
    before = legacy.read_bytes()
    with pytest.raises(SchemaError, match="import-sqlite"):
        Repository(f"sqlite:///{legacy}")
    con = sqlite3.connect(legacy)
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    con.close()
    assert "companies" not in tables and legacy.read_bytes() == before


def test_cli_reports_a_section1_file_instead_of_crashing(tmp_path, capsys):
    from leadmaker.cli import main

    legacy = tmp_path / "leadmaker.db"
    con = sqlite3.connect(legacy)
    con.executescript((FIX / "section1_schema.sql").read_text())
    con.close()
    assert main(["--db", f"sqlite:///{legacy}", "stats"]) == 2
    assert "import-sqlite" in capsys.readouterr().err


@pytest.mark.parametrize("url,expected", [
    ("postgres://u:p@localhost:55432/leadmaker", "postgresql+psycopg://u:p@localhost:55432/leadmaker"),
    ("postgresql://u:p@db/leadmaker?schema=public", "postgresql+psycopg://u:p@db/leadmaker"),
    ("postgresql+psycopg://u:p@db/leadmaker?sslmode=disable", "postgresql+psycopg://u:p@db/leadmaker?sslmode=disable"),
    ("sqlite:///data/x.db", "sqlite:///data/x.db"),
])
def test_database_urls_from_the_node_side_are_accepted(url, expected):
    assert normalize_url(url) == expected


def test_outbox_rejects_events_without_an_actor_type(repo):
    """The SQLite mirror enforces the migration's payload CHECK, so a missing actor_type fails offline too."""
    with pytest.raises(Exception, match="CHECK"):
        with repo.engine.begin() as conn:
            conn.execute(insert(outbox_events).values(event_type="lead.updated", payload={"company_id": "x"},
                                                      created_at=utcnow()))
    with pytest.raises(Exception, match="CHECK"):
        with repo.engine.begin() as conn:
            conn.execute(insert(outbox_events).values(event_type="lead.renamed", payload={"actor_type": "pipeline"},
                                                      created_at=utcnow()))


def test_tied_contacts_keep_the_order_their_source_reported(repo):
    """The target contact among equally ranked people is the one the source listed first (e.g. FMCSA's officer 1,
    who carries the email), so storage must keep discovery order; contact ids are time-ordered for that."""
    cs = fixture_contractors()
    _poll(repo, cs)
    company = cid(repo, cs[0].gaf_id)
    officers = EnrichmentResult(source="fmcsa", status=EnrichmentStatus.OK, confidence=0.9, data={},
                                source_urls=["https://dot.example"], contacts=[
                                    Contact(name="Zed First", title="Company officer", source="fmcsa", confidence=0.89,
                                            email="zed@example.com"),
                                    Contact(name="Amy Second", title="Company officer", source="fmcsa", confidence=0.89)])
    repo.save_enrichment(company, officers, run_id=repo.start_run("enrich", {}))
    (lead,) = [l for l in repo.lead_records("10013", 25) if l["company_id"] == company]
    assert [c["name"] for c in lead["contacts"]] == ["Zed First", "Amy Second"]
    from leadmaker.tagging import tag_lead

    target = next(t for t in tag_lead(lead)["tags"] if t["key"] == "target_contact")
    assert target["contact"]["name"] == "Zed First" and target["contact"]["email"] == "zed@example.com"


def test_scraped_strings_are_cut_to_their_column_length():
    from leadmaker.db.repository import fit

    row = fit(contacts, {"title": "x" * 300, "name": "Pat", "confidence": 0.5, "unknown": "y" * 999})
    assert len(row["title"]) == 255 and row["name"] == "Pat" and len(row["unknown"]) == 999
    assert fit(companies, {"website_url": "u" * 2000})["website_url"] == "u" * 2000  # TEXT: no limit
