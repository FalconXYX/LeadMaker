"""The territory briefing on Postgres: the migration's tables and CHECK, digest JSONB round trip, the fake
rewrite cached by (scope, digest_hash, prompt version, model), and the query service's read of it (§6.2 d)."""

from __future__ import annotations

import asyncio
import sys
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import insert, select, text
from sqlalchemy.exc import IntegrityError

from leadmaker.briefing import BRIEFING_PROMPT_VERSION, compute_digest, digest_hash, render_digest_text, run_briefing
from leadmaker.db.schema import territory_brief_rewrites, territory_briefs

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_briefing_support import NOW, assign, fake, seed_scenario, settings  # noqa: E402

pytestmark = pytest.mark.pg

# The query service's read (packages: services/query territory-brief), kept here to pin the contract.
QUERY_SQL = text("""
  SELECT b.scope, b.digest, b.digest_text, b.digest_hash, b.quiet, b.computed_at,
         r.ai_text, r.generated_at, r.model, r.prompt_version
  FROM territory_briefs b
  LEFT JOIN LATERAL (SELECT ai_text, generated_at, model, prompt_version FROM territory_brief_rewrites r
                     WHERE r.scope = b.scope AND r.digest_hash = b.digest_hash
                     ORDER BY generated_at DESC LIMIT 1) r ON TRUE
  WHERE b.scope = :scope
""")


@pytest.fixture(autouse=True)
def _no_live_llm(monkeypatch):
    for k in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "LEADMAKER_LLM_BASE_URL",
              "LEADMAKER_BRIEFING_AI", "LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES", "LEADMAKER_BRIEFING_POLL_WINDOW_DAYS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("LEADMAKER_LLM_PROVIDER", "auto")


def run(repo, **kw):
    kw.setdefault("now", NOW)
    return asyncio.run(run_briefing(settings(), repo, **kw))


def read(repo, scope):
    with repo.engine.connect() as conn:
        return conn.execute(QUERY_SQL, {"scope": scope}).mappings().first()


def test_briefing_on_postgres(pg):
    ids = seed_scenario(pg)
    scopes = ["team", f"rep:{ids['rep_a']}", f"rep:{ids['rep_b']}"]

    out = run(pg, rewrite=False)
    assert out["scopes"] == 3 and out["changed"] == 3 and out["quiet"] == 0
    for scope in scopes:
        row = read(pg, scope)
        d = compute_digest(pg, scope, NOW)
        assert row["digest"] == d  # JSONB round trip
        assert row["digest_text"] == render_digest_text(d) and row["digest_hash"] == digest_hash(d)
        assert row["ai_text"] is None  # no rewrite yet: the service serves digest_text

    llm = fake()
    out = run(pg, provider=llm, now=NOW + timedelta(minutes=5))
    assert out["rewritten"] == 3 and len(llm.calls) == 3 and out["changed"] == 0
    team = read(pg, "team")
    assert team["ai_text"] == team["digest_text"] and team["model"] == "fake:fake-1"
    assert team["prompt_version"] == BRIEFING_PROMPT_VERSION

    again = fake()
    out = run(pg, provider=again, now=NOW + timedelta(minutes=10))
    assert again.calls == [] and out["rewrite_skipped"]["cached"] == 3

    # a changed digest: the old rewrite no longer matches the hash, so the service falls back to the digest text
    assign(pg, ids["echo"], ids["rep_a"])
    out = run(pg, provider=fake(), now=NOW + timedelta(minutes=20))
    assert out["rewrite_skipped"]["min_interval"] == 2
    rep_a = read(pg, f"rep:{ids['rep_a']}")
    assert rep_a["ai_text"] is None and rep_a["digest_text"]


def test_scope_check_constraint(pg):
    row = {"digest": {}, "digest_text": "", "digest_hash": "0" * 64, "quiet": True}
    with pg.engine.begin() as conn:
        conn.execute(insert(territory_briefs).values(scope="team", **row))
        conn.execute(insert(territory_briefs).values(scope=f"rep:{uuid.uuid4()}", **row))
    for bad in ("mine", "rep:123", "manager:" + str(uuid.uuid4())):
        with pytest.raises(IntegrityError), pg.engine.begin() as conn:
            conn.execute(insert(territory_briefs).values(scope=bad, **row))


def test_rewrite_primary_key_and_upsert(pg):
    seed_scenario(pg)
    run(pg, provider=fake(), scopes=["team"])
    run(pg, provider=fake(), scopes=["team"], force=True, now=NOW + timedelta(minutes=1))  # cached: no new row
    with pg.engine.connect() as conn:
        n = conn.execute(select(territory_brief_rewrites.c.scope).where(
            territory_brief_rewrites.c.scope == "team")).all()
    assert len(n) == 1
