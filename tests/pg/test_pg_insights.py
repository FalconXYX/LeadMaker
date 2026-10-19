"""Batch insights on Postgres: a fake-provider run writes ok rows that the migration's columns, CHECK and partial
index accept, each with one lead.updated event in the same transaction and no version bump; the stale
prefilter's SQL runs on Postgres; the partial index serves the "latest ok insight" read."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from leadmaker.db import Repository
from leadmaker.db.schema import company_insights, regional_signals
from leadmaker.insights import InsightsOptions, candidates, run_insights
from leadmaker.insights.store import save_result

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_insights_support import (  # noqa: E402
    add_note, fake, fake_settings, insight_events, insight_rows, seeded, version,
)
from test_insights_store import ok_result  # noqa: E402

pytestmark = pytest.mark.pg


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("LEADMAKER_INSIGHTS_BATCH_SIZE", "LEADMAKER_INSIGHTS_MAX_ATTEMPTS", "LEADMAKER_FAKE_LLM_SCRIPT"):
        monkeypatch.delenv(k, raising=False)


async def test_a_run_on_postgres(pg: Repository):
    ids = seeded(pg)
    versions = {c: version(pg, c) for c in ids}
    out = await run_insights(fake_settings(), pg, InsightsOptions(batch_size=3), provider=fake())
    assert out["status"] == "succeeded" and out["generated"] == 6 and out["llm_calls"] == 2
    rows = insight_rows(pg)
    assert len(rows) == 6 and all(r["status"] == "ok" and r["attempts"] == 1 for r in rows)
    assert all(isinstance(r["talking_points"], list) and r["product_focus"] and r["cited_facts"] for r in rows)
    assert all(r["token_usage"]["batch_size"] == 3 for r in rows)
    events = insight_events(pg)
    assert sorted(e["company_id"] for e in events) == sorted(ids)
    assert all(e["payload"]["version"] == versions[e["company_id"]] and e["payload"]["material"] is False
               for e in events)
    assert {c: version(pg, c) for c in ids} == versions  # no companies write (D4)
    again = await run_insights(fake_settings(), pg, InsightsOptions(), provider=fake())
    assert again["skipped_unchanged"] == 6 and again["llm_calls"] == 0


async def test_stale_on_postgres(pg: Repository):
    ids = seeded(pg)
    await run_insights(fake_settings(), pg, InsightsOptions(), provider=fake())
    assert candidates(pg) == []
    now = datetime.now(timezone.utc)
    with pg.engine.begin() as conn:
        conn.execute(regional_signals.insert().values(
            county_fips="36061", kind="active_alert", source="nws", external_id="urn:test:pg", payload={},
            valid_from=now, valid_to=now + timedelta(hours=2)))
    assert candidates(pg) == []
    add_note(pg, ids[2], "Wants net-30 terms")
    assert candidates(pg) == [ids[2]]
    out = await run_insights(fake_settings(), pg, InsightsOptions(stale=True), provider=fake())
    assert out["generated"] == 1 and out["llm_calls"] == 1


def test_upsert_check_and_same_transaction_on_postgres(pg: Repository, monkeypatch):
    cid = seeded(pg)[0]
    save_result(pg, ok_result(cid), None)
    save_result(pg, ok_result(cid), None)
    (row,) = insight_rows(pg, cid)
    assert row["attempts"] == 2
    with pytest.raises(IntegrityError):
        with pg.engine.begin() as conn:
            conn.execute(company_insights.insert().values(
                company_id=cid, business_summary="", sales_recommendation="", model="m", prompt_version="v",
                input_hash="h9", status="pending"))

    def boom(*a, **k):
        raise RuntimeError("outbox down")

    monkeypatch.setattr(Repository, "_lead_updated", staticmethod(boom))
    with pytest.raises(RuntimeError):
        save_result(pg, ok_result(cid, "h2"), None)
    assert [r["input_hash"] for r in insight_rows(pg, cid)] == ["h1"]


def test_the_partial_index_serves_the_latest_ok_read(pg: Repository):
    cid = seeded(pg)[0]
    v = version(pg, cid)
    save_result(pg, ok_result(cid), None)
    assert version(pg, cid) == v  # the version trigger never fires: companies is not written
    with pg.engine.begin() as conn:
        conn.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join(conn.execute(text(
            "EXPLAIN SELECT * FROM company_insights WHERE company_id = :c AND status = 'ok' "
            "ORDER BY generated_at DESC LIMIT 1"), {"c": cid}).scalars())
        cols = {r.column_name for r in conn.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'company_insights'"))}
    assert "company_insights_ok_latest_idx" in plan
    assert {"status", "error", "attempts", "talking_points", "target_contact", "product_focus", "cited_facts",
            "token_usage"} <= cols
