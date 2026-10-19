"""Storing insight results: the upsert on (company_id, input_hash), pruning, error rows, and the lead.updated
outbox event written in the same transaction without touching companies (D4)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from leadmaker.db import Repository
from leadmaker.db.schema import companies
from leadmaker.insights import InsightResult, save_results
from leadmaker.insights.store import KEEP_ROWS, latest_insight, prune, redact, save_result
from leadmaker.insights.validate import clean_item

from test_insights_support import ME_LEAD, age_rows, insight_events, insight_rows, lead, seeded, valid_item, version

ME = lead(ME_LEAD)


def ok_result(company_id: str, h: str = "h1") -> InsightResult:
    return InsightResult(company_id=company_id, ok=True, insight=clean_item(valid_item(), ME), violations=[], attempts=1,
                         usage={"input_tokens": 100, "output_tokens": 40, "batch_size": 2}, input_hash=h,
                         model="fake:fake-1")


def error_result(company_id: str, h: str = "h1", violations=("cited F19, which does not exist",)) -> InsightResult:
    return InsightResult(company_id=company_id, ok=False, insight=None, violations=list(violations), attempts=2,
                         usage={"input_tokens": 10, "output_tokens": 5, "batch_size": 1}, input_hash=h,
                         model="fake:fake-1")


def updated_at(repo: Repository, company_id: str):
    with repo.engine.connect() as conn:
        return conn.execute(select(companies.c.updated_at).where(companies.c.id == company_id)).scalar()


def test_an_ok_row_and_its_event(repo):
    cid = seeded(repo)[0]
    v, ts = version(repo, cid), updated_at(repo, cid)
    assert save_result(repo, ok_result(cid), run_id=7) == "ok"
    (row,) = insight_rows(repo, cid)
    assert row["status"] == "ok" and row["error"] is None and row["attempts"] == 1
    assert row["business_summary"].startswith("Carework Construction LLC is a GAF Master Elite roofer")
    assert row["sales_recommendation"].startswith("Lead with bulk architectural shingles")
    assert len(row["talking_points"]) == 2 and all(isinstance(t, str) for t in row["talking_points"])
    assert row["target_contact"] == {"name": "Jose Sucuzhanay Sr.", "title": "President",
                                     "why": "Owner; signs off on suppliers."}
    assert row["product_focus"] == ["architectural_shingles", "underlayment"]
    assert row["cited_facts"][0] == {"id": "F1", "text": "business_name: Carework Construction LLC"}
    assert row["model"] == "fake:fake-1" and row["prompt_version"] == "insights/v3" and row["input_hash"] == "h1"
    assert row["token_usage"] == {"input_tokens": 100, "output_tokens": 40, "batch_size": 2}
    (event,) = insight_events(repo)
    assert event["company_id"] == cid
    assert event["payload"] == {"company_id": cid, "actor_type": "pipeline", "actor_id": None, "version": v,
                                "run_id": 7, "fields": ["insights"], "material": False}
    assert version(repo, cid) == v and updated_at(repo, cid) == ts  # companies untouched (D4)


def test_the_same_hash_upserts_in_place_and_counts_attempts(repo):
    cid = seeded(repo)[0]
    save_result(repo, error_result(cid), None)
    save_result(repo, error_result(cid), None)
    (row,) = insight_rows(repo, cid)
    assert row["status"] == "error" and row["attempts"] == 2
    save_result(repo, ok_result(cid), None)
    (row,) = insight_rows(repo, cid)
    assert row["status"] == "ok" and row["attempts"] == 3 and row["error"] is None and row["business_summary"]


def test_error_rows_are_empty_emit_the_event_and_never_hold_secrets(repo):
    cid = seeded(repo)[0]
    r = error_result(cid, violations=["cited F19, which does not exist",
                                      "upstream said key=AIzaSyA1234567890abcdefghijklmnop is invalid"])
    assert save_result(repo, r, None) == "error"
    (row,) = insight_rows(repo, cid)
    assert row["business_summary"] == "" and row["sales_recommendation"] == "" and row["talking_points"] == []
    assert row["target_contact"] is None and row["product_focus"] == [] and row["cited_facts"] == []
    assert row["error"].startswith("cited F19, which does not exist; upstream said key=[redacted]")
    assert "AIza" not in row["error"]
    # Refresh fix: an error row emits lead.updated ['insights'] (not material) so a waiting profile sees the failed
    # attempt (LeadProfile.insightAttempt) instead of timing out; the event carries no error text.
    (ev,) = insight_events(repo)
    assert ev["company_id"] == cid and ev["payload"]["material"] is False and "AIza" not in str(ev["payload"])
    assert redact("x-goog-api-key: abc sk-ant-api03-abcdefghijkl") == "x-goog-api-key: [redacted] [redacted]"


def test_deferred_results_write_nothing(repo):
    cid = seeded(repo)[0]
    r = ok_result(cid)
    r.deferred = "quota"
    assert save_results(repo, [r, ok_result(cid, "h2")], None) == {"ok": 1, "error": 0, "deferred": 1}
    assert [x["input_hash"] for x in insight_rows(repo, cid)] == ["h2"]


def test_prune_keeps_the_newest_three_and_the_newest_ok_row(repo):
    cid = seeded(repo)[0]
    for i in range(5):
        save_result(repo, ok_result(cid, f"ok{i}"), None)
        age_rows(repo, 1)
    assert [r["input_hash"] for r in insight_rows(repo, cid)] == ["ok2", "ok3", "ok4"]
    for i in range(3):
        save_result(repo, error_result(cid, f"err{i}"), None)
        age_rows(repo, 1)
    rows = insight_rows(repo, cid)
    assert len(rows) == KEEP_ROWS + 1 and rows[0]["input_hash"] == "ok4"  # the last good insight survives
    assert latest_insight(repo, cid)["input_hash"] == "err2"
    with repo.engine.begin() as conn:
        assert prune(conn, cid) == 0


def test_the_event_is_in_the_same_transaction(repo, monkeypatch):
    cid = seeded(repo)[0]

    def boom(*a, **k):
        raise RuntimeError("outbox down")

    monkeypatch.setattr(Repository, "_lead_updated", staticmethod(boom))
    with pytest.raises(RuntimeError):
        save_result(repo, ok_result(cid), None)
    assert insight_rows(repo, cid) == []  # rolled back with the failed event
