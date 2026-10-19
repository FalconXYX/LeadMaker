"""run_briefing, the cached AI rewrite, the store and the `leadmaker briefing` CLI (fake provider only)."""

from __future__ import annotations

import argparse
import json
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import insert, select, update

from leadmaker.briefing import (
    BRIEFING_PROMPT_VERSION, BRIEFING_SCHEMA, BRIEFING_SYSTEM_PROMPT, compute_digest, digest_hash,
    render_digest_text, run_briefing, validate_rewrite,
)
from leadmaker.briefing import cli as briefing_cli
from leadmaker.briefing import store
from leadmaker.briefing.rewrite import build_user_message, prompt_digest
from leadmaker.db import Repository
from leadmaker.db.schema import schedules, territory_brief_rewrites, territory_briefs, users
from leadmaker.llm import LlmApiError

from test_briefing_support import NOW, add_user, assign, fake, seed_scenario, settings

LLM_ENV = ("GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "LEADMAKER_LLM_BASE_URL", "LEADMAKER_LLM_API_KEY",
           "LEADMAKER_LLM_MODEL", "LEADMAKER_FAKE_LLM_SCRIPT")


@pytest.fixture(autouse=True)
def _no_live_llm(monkeypatch):
    """Whatever .env holds, these tests can never reach a real provider."""
    for k in LLM_ENV + ("LEADMAKER_BRIEFING_AI", "LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES",
                        "LEADMAKER_BRIEFING_POLL_WINDOW_DAYS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("LEADMAKER_LLM_PROVIDER", "auto")  # no keys -> no provider unless a test names the fake


@pytest.fixture
def ids(repo):
    return seed_scenario(repo)


def run(repo, **kw):
    import asyncio

    kw.setdefault("now", NOW)
    return asyncio.run(run_briefing(kw.pop("settings", settings()), repo, **kw))


def briefs(repo) -> dict[str, dict]:
    with repo.engine.connect() as conn:
        return {r.scope: dict(r._mapping) for r in conn.execute(select(territory_briefs))}


def rewrites(repo) -> list[dict]:
    with repo.engine.connect() as conn:
        return [dict(r._mapping) for r in conn.execute(
            select(territory_brief_rewrites).order_by(territory_brief_rewrites.c.scope,
                                                      territory_brief_rewrites.c.generated_at))]


def scopes_of(ids) -> list[str]:
    return sorted(["team", f"rep:{ids['rep_a']}", f"rep:{ids['rep_b']}"])


# ---------------------------------------------------------------------------------------------- digests
def test_digest_only_writes_team_and_every_rep(repo, ids):
    out = run(repo, rewrite=False)
    assert out["scopes"] == 3 and out["changed"] == 3 and out["quiet"] == 0 and out["llm_calls"] == 0
    assert out["rewrite_skipped"]["disabled"] == 3 and out["rewritten"] == 0
    rows = briefs(repo)
    assert sorted(rows) == scopes_of(ids)
    for scope, row in rows.items():
        d = compute_digest(repo, scope, NOW)
        assert row["digest"] == d
        assert row["digest_text"] == render_digest_text(d) != ""
        assert row["digest_hash"] == digest_hash(d)
        assert row["quiet"] is False and row["poll_run_id"] == ids["run"]
    assert rewrites(repo) == []


def test_rerun_keeps_hashes_and_moves_computed_at(repo, ids):
    run(repo, rewrite=False)
    first = briefs(repo)
    out = run(repo, rewrite=False, now=NOW + timedelta(minutes=20))
    assert out["changed"] == 0
    second = briefs(repo)
    for scope in first:
        assert second[scope]["digest_hash"] == first[scope]["digest_hash"]
        assert store.as_utc(second[scope]["computed_at"]) > store.as_utc(first[scope]["computed_at"])


def test_quiet_rows_store_empty_text_and_never_call(repo):
    rep = add_user(repo, "Quiet Rep")
    llm = fake()
    out = run(repo, provider=llm)
    assert out["scopes"] == 2 and out["quiet"] == 2 and llm.calls == []
    rows = briefs(repo)
    assert rows[f"rep:{rep}"]["quiet"] is True and rows[f"rep:{rep}"]["digest_text"] == ""
    assert rows["team"]["quiet"] is True


def test_unknown_scopes_are_reported(repo, ids):
    stranger = f"rep:{uuid.uuid4()}"
    out = run(repo, scopes=[stranger, f"rep:{ids['manager']}", "nonsense", "team"], rewrite=False)
    assert out["scopes"] == 1 and sorted(out["unknown_scopes"]) == sorted([stranger, f"rep:{ids['manager']}",
                                                                          "nonsense"])
    assert sorted(briefs(repo)) == ["team"]


# ----------------------------------------------------------------------------------------------- rewrite
def test_fake_rewrite_is_stored_once_then_cached(repo, ids):
    llm = fake()
    out = run(repo, provider=llm)
    assert out["rewritten"] == 3 and out["llm_calls"] == 3 and out["provider"] == "fake:fake-1"
    rows = rewrites(repo)
    assert len(rows) == 3
    for r in rows:
        b = briefs(repo)[r["scope"]]
        assert r["digest_hash"] == b["digest_hash"] and r["prompt_version"] == BRIEFING_PROMPT_VERSION
        assert r["model"] == "fake:fake-1" and r["ai_text"] == b["digest_text"]  # the fake echoes the digest text
    call = llm.calls[0]
    assert call["schema_name"] == "briefing_rewrite" and call["system"] == BRIEFING_SYSTEM_PROMPT

    again = fake()
    out2 = run(repo, provider=again, now=NOW + timedelta(hours=3))
    assert again.calls == [] and out2["llm_calls"] == 0 and out2["rewrite_skipped"]["cached"] == 3
    assert len(rewrites(repo)) == 3


def test_min_interval_then_force(repo, ids):
    run(repo, provider=fake())
    assign(repo, ids["echo"], ids["rep_a"])  # rep A's and the team's digests change; rep B's does not
    llm = fake()
    out = run(repo, provider=llm, now=NOW + timedelta(minutes=10))
    assert out["changed"] == 2 and llm.calls == []
    assert out["rewrite_skipped"]["min_interval"] == 2 and out["rewrite_skipped"]["cached"] == 1
    forced = fake()
    out = run(repo, provider=forced, now=NOW + timedelta(minutes=11), force=True)
    assert len(forced.calls) == 2 and out["rewritten"] == 2
    assign(repo, ids["echo"], None)  # back to the first digest: its rewrite is still cached
    later = fake()
    out = run(repo, provider=later, now=NOW + timedelta(minutes=12))
    assert later.calls == [] and out["rewrite_skipped"]["cached"] == 3


def test_min_interval_setting_and_expiry(repo, ids, monkeypatch):
    run(repo, provider=fake())
    assign(repo, ids["echo"], ids["rep_a"])
    llm = fake()
    run(repo, provider=llm, now=NOW + timedelta(minutes=61))  # past the default 60 minutes
    assert len(llm.calls) == 2
    monkeypatch.setenv("LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES", "0")
    assign(repo, ids["echo"], None)
    assign(repo, ids["beta"], ids["rep_b"])
    llm = fake()
    out = run(repo, provider=llm, now=NOW + timedelta(minutes=62))
    # rep A (rewritten a minute ago) and rep B changed and are rewritten at once; the team digest is back to the
    # first one, whose rewrite is cached
    assert len(llm.calls) == 2 and out["rewrite_skipped"]["cached"] == 1 and out["rewrite_skipped"]["min_interval"] == 0


def test_invalid_rewrite_is_negative_cached(repo, ids):
    """AI review M2: an invalid answer used to store nothing, so every later run called the model again for the same
    digest. Now it stores an empty marker row: the query service skips it, and the same digest is "cached"."""
    from leadmaker.briefing import store

    team = "team"
    bad = {"text": "Severe Thunderstorm Warning in Bergen County: 99 storm-restoration roofers need tarps today.",
           "company_ids": []}
    llm = fake(script=[bad])
    out = run(repo, provider=llm, scopes=[team])
    assert out["rewrite_skipped"]["invalid"] == 1 and out["rewritten"] == 0
    assert "99" in out["rewrite_errors"][0]["violations"][0]
    (marker,) = rewrites(repo)
    assert marker["ai_text"] == "" and marker["prompt_version"] == "briefing/v3"
    assert briefs(repo)["team"]["digest_text"]  # the digest is still stored
    assert store.latest_rewrite(repo, team, marker["digest_hash"]) is None  # never served
    again = run(repo, provider=llm, scopes=[team], force=True)
    assert again["llm_calls"] == 0 and again["rewrite_skipped"]["cached"] == 1 and len(llm.calls) == 1


def test_quota_stops_rewrites_but_not_digests(repo, ids):
    llm = fake(script=[{"error": "quota"}])
    out = run(repo, provider=llm)
    assert out["llm_calls"] == 1 and len(llm.calls) == 1
    assert out["rewrite_skipped"]["quota"] == 3 and out["rewritten"] == 0
    assert sorted(briefs(repo)) == scopes_of(ids) and rewrites(repo) == []


def test_other_errors_skip_only_that_scope(repo, ids):
    llm = fake(script=[LlmApiError("upstream 503", provider="fake", status=503)])
    out = run(repo, provider=llm)
    assert out["rewrite_skipped"]["error"] == 1 and out["rewritten"] == 2 and len(llm.calls) == 3
    assert out["rewrite_errors"][0]["error"] == "LlmApiError" and out["rewrite_errors"][0]["status"] == 503
    assert len(rewrites(repo)) == 2


def test_auth_error_stops_calling(repo, ids):
    llm = fake(script=[{"error": "auth"}])
    out = run(repo, provider=llm)
    assert len(llm.calls) == 1 and out["rewrite_skipped"]["error"] == 1
    assert out["rewrite_skipped"]["no_provider"] == 2 and out["rewritten"] == 0
    assert out["rewrite_errors"] == [{"scope": "team", "error": "LlmAuthError", "status": 401}]
    assert sorted(briefs(repo)) == scopes_of(ids)


def test_a_single_scope_string(repo, ids):
    out = run(repo, scopes="team", rewrite=False)
    assert out["scopes"] == 1 and "unknown_scopes" not in out


def test_no_provider(repo, ids):
    out = run(repo)  # settings(): auto with no keys
    assert out["provider"] is None and out["rewrite_skipped"]["no_provider"] == 3 and out["llm_calls"] == 0
    assert out["no_provider_reason"] and sorted(briefs(repo)) == scopes_of(ids)


def test_fake_provider_named_in_settings(repo, ids, monkeypatch):
    from test_briefing_support import fake_settings

    out = run(repo, settings=fake_settings(), scopes=["team"])
    assert out["provider"] == "fake:fake-1" and out["rewritten"] == 1


def test_ai_off_by_env(repo, ids, monkeypatch):
    monkeypatch.setenv("LEADMAKER_BRIEFING_AI", "0")
    llm = fake()
    out = run(repo, provider=llm)
    assert llm.calls == [] and out["rewrite_skipped"]["disabled"] == 3
    out = run(repo, provider=llm, rewrite=True)  # an explicit rewrite=True wins over the env default
    assert out["rewritten"] == 3


def test_prompt_carries_the_digest_without_internal_ids(repo, ids):
    llm = fake()
    run(repo, provider=llm, scopes=["team"])
    user = llm.calls[0]["user"]
    assert user.startswith("<digest>{") and "<digest_text>" in user
    for internal in ("urn:oid:", '"run_id"', '"scope"', '"as_of"', "34003", ids["rep_a"]):
        assert internal not in user
    assert ids["alpha"] in user  # company ids stay: the model lists the ones it names
    d = compute_digest(repo, "team", NOW)
    assert user == build_user_message(d, render_digest_text(d))
    assert "leads" in prompt_digest(d) and prompt_digest(d)["leads"][0] == {"company_id": ids["alpha"],
                                                                            "name": "Alpha Roofing"}


def test_schema_is_strict():
    assert set(BRIEFING_SCHEMA["required"]) == {"text", "company_ids"} == set(BRIEFING_SCHEMA["properties"])
    assert BRIEFING_SCHEMA["additionalProperties"] is False


# --------------------------------------------------------------------------------------------- validate
DIGEST = {"poll": {"highlights": [{"company_id": "c1", "name": "Carework Construction LLC"}]},
          "weather": {"storm_response": [{"company_id": "c2", "name": "Storm Pros"}]},
          "leads": [{"id": "c1", "name": "Carework Construction LLC"}]}
TEXT = ("Severe Thunderstorm Warning in Bergen County until 8 PM: 4 storm-restoration roofers there may need tarps "
        "and repair stock. Since Saturday's poll: 3 new leads in this territory.")


@pytest.mark.parametrize("data,problem", [
    ({"text": "Bergen County has a Severe Thunderstorm Warning until 8 PM, so 4 storm-restoration roofers may need "
              "tarps. 3 new leads arrived since Saturday.", "company_ids": []}, None),
    ({"text": "Carework Construction LLC leads 4 storm-restoration roofers under a warning until 8 PM.",
      "company_ids": ["c1", "c2"]}, None),
    ({"text": "Short.", "company_ids": []}, "characters"),
    ({"text": "x " * 250, "company_ids": []}, "characters"),
    ({"text": "Bergen County: 5 storm-restoration roofers may need tarps until 8 PM, plus 3 new leads.",
      "company_ids": []}, "numbers not in the digest text: 5"),
    ({"text": "Bergen County: 4 storm-restoration roofers may need tarps until 8 PM. 3 new leads, 7 total.",
      "company_ids": []}, "7"),
    ({"text": "Bergen County: 4 storm-restoration roofers may need tarps until 8 PM; 3 new leads.",
      "company_ids": ["c9"]}, "company_ids not in the digest: c9"),
    ({"text": "Bergen County: 4 storm-restoration roofers may need tarps until 8 PM; see https://x.example now.",
      "company_ids": []}, "URL"),
    ({"text": "Bergen County: 4 storm-restoration roofers may need tarps; email ops@example.com by 8 PM.",
      "company_ids": []}, "URL or email"),
    ({"text": "Your territory: 4 storm-restoration roofers may need tarps until 8 PM, and 3 new leads.",
      "company_ids": []}, '"you"/"your"'),
    ({"text": "You should call 4 storm-restoration roofers before 8 PM about tarps; 3 new leads too.",
      "company_ids": []}, '"you"/"your"'),
    ({"text": "Big news! 4 storm-restoration roofers may need tarps until 8 PM, and 3 new leads arrived.",
      "company_ids": []}, "exclamation"),
    ({"text": "**Storm:** 4 storm-restoration roofers may need tarps until 8 PM, and 3 new leads arrived.",
      "company_ids": []}, "markdown"),
    ({"text": "4 storm-restoration roofers may need tarps until 8 PM, and 3 new leads arrived since Saturday.",
      "company_ids": "c1"}, "company_ids is not a list"),
    ({"company_ids": []}, "text is missing"),
    ("not an object", "not an object"),
])
def test_validate_rewrite(data, problem):
    violations = validate_rewrite(data, DIGEST, TEXT)
    if problem is None:
        assert violations == []
    else:
        assert any(problem in v for v in violations), violations


# ------------------------------------------------------------------------------------------------- store
def test_prune_keeps_five_rewrites_per_scope(repo, ids):
    with repo.engine.begin() as conn:
        conn.execute(insert(territory_brief_rewrites), [
            {"scope": "team", "digest_hash": f"{i:064d}", "prompt_version": BRIEFING_PROMPT_VERSION,
             "model": "fake:fake-1", "ai_text": f"old {i}", "generated_at": NOW - timedelta(days=10 - i)}
            for i in range(7)
        ])
    run(repo, rewrite=False)
    kept = [r["ai_text"] for r in rewrites(repo) if r["scope"] == "team"]
    assert kept == [f"old {i}" for i in range(2, 7)]


def test_prune_drops_scopes_of_former_reps(repo, ids):
    run(repo, provider=fake())
    with repo.engine.begin() as conn:
        conn.execute(update(users).where(users.c.id == ids["rep_b"]).values(role="manager"))
    out = run(repo, rewrite=False)
    assert out["scopes"] == 2 and out["pruned"] == {"briefs": 1, "rewrites": 1}
    assert f"rep:{ids['rep_b']}" not in briefs(repo)
    assert all(r["scope"] != f"rep:{ids['rep_b']}" for r in rewrites(repo))


def test_latest_rewrite_matches_the_hash(repo, ids):
    run(repo, provider=fake(), scopes=["team"])
    b = store.get_brief(repo, "team")
    assert store.latest_rewrite(repo, "team", b["digest_hash"])["ai_text"] == b["digest_text"]
    assert store.latest_rewrite(repo, "team", "0" * 64) is None


# --------------------------------------------------------------------------------------------------- CLI
def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="leadmaker")
    p.add_argument("--db")
    briefing_cli.register(p.add_subparsers(dest="command", required=True))
    return p


def cli(*argv: str) -> int:
    args = parser().parse_args(list(argv))
    return args.fn(args)


@pytest.fixture
def db_url(tmp_path) -> str:
    url = f"sqlite:///{tmp_path / 'cli.db'}"
    seed_scenario(Repository(url))
    return url


def test_cli_no_ai_print(db_url, capsys):
    assert cli("--db", db_url, "briefing", "--no-ai", "--print") == 0
    out = json.loads(capsys.readouterr().out)
    assert out["scopes"] == 3 and out["llm_calls"] == 0
    assert len(out["texts"]) == 3 and all(t["digest_text"] and t["ai_text"] is None for t in out["texts"])
    assert "key" not in json.dumps(out).lower()


def test_cli_scope_team_with_the_fake(db_url, capsys, monkeypatch):
    monkeypatch.setenv("LEADMAKER_LLM_PROVIDER", "fake")
    assert cli("--db", db_url, "briefing", "--scope", "team", "--print") == 0
    out = json.loads(capsys.readouterr().out)
    assert out["scopes"] == 1 and out["rewritten"] == 1 and out["provider"] == "fake:fake-1"
    assert [t["scope"] for t in out["texts"]] == ["team"] and out["texts"][0]["ai_text"]


def test_cli_rejects_a_bad_scope(db_url, capsys):
    assert cli("--db", db_url, "briefing", "--scope", "rep:nope", "--no-ai") == 2
    assert "invalid briefing scope" in capsys.readouterr().err
    assert cli("--db", db_url, "briefing", "--scope", f"rep:{uuid.uuid4()}", "--no-ai") == 1
    assert "unknown scope" in capsys.readouterr().err


def test_cli_schedule(db_url, capsys):
    assert cli("--db", db_url, "briefing", "schedule", "--every-hours", "1") == 0
    assert json.loads(capsys.readouterr().out)["name"] == "briefing"
    assert cli("--db", db_url, "briefing", "schedule", "--every-hours", "2") == 0  # an upsert by name
    with Repository(db_url).engine.connect() as conn:
        rows = conn.execute(select(schedules.c.kind, schedules.c.every_hours).where(schedules.c.name == "briefing")).all()
    assert [(r.kind, float(r.every_hours)) for r in rows] == [("briefing", 2.0)]
    assert cli("--db", db_url, "briefing", "schedule", "--every-hours", "0") == 2


def test_cli_refuses_the_seed_file(monkeypatch, capsys):
    import leadmaker.db

    def never(*a, **kw):  # a broken guard must not even open the file
        raise AssertionError("the seed file was opened")

    monkeypatch.setattr(leadmaker.db, "Repository", never)
    seed = briefing_cli.SEED_FILE
    before = seed.stat().st_mtime_ns if seed.exists() else None
    monkeypatch.delenv("LEADMAKER_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert cli("briefing", "--no-ai") == 2
    assert "refusing to write the Section 1 seed file" in capsys.readouterr().err
    assert cli("--db", f"sqlite:///{seed}", "briefing") == 2
    assert cli("briefing", "schedule", "--every-hours", "1") == 2
    after = seed.stat().st_mtime_ns if seed.exists() else None
    assert before == after


def test_is_seed_file(tmp_path, monkeypatch):
    monkeypatch.chdir(briefing_cli.REPO_ROOT)
    assert briefing_cli.is_seed_file("sqlite:///data/leadmaker.db")
    assert briefing_cli.is_seed_file("sqlite:///data/../data/leadmaker.db")
    assert briefing_cli.is_seed_file(f"sqlite:///{briefing_cli.SEED_FILE}")
    assert not briefing_cli.is_seed_file(f"sqlite:///{tmp_path / 'leadmaker.db'}")
    assert not briefing_cli.is_seed_file("postgresql+psycopg://u:p@localhost:55432/leadmaker")
    assert not briefing_cli.is_seed_file("sqlite://")


# ------------------------------------------------------------------------------------------------ config
def test_config_from_env():
    from leadmaker.briefing.config import BriefingConfig

    assert BriefingConfig.from_env({}) == BriefingConfig(ai=True, rewrite_min_minutes=60, poll_window_days=7)
    cfg = BriefingConfig.from_env({"LEADMAKER_BRIEFING_AI": "off", "LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES": "15",
                                   "LEADMAKER_BRIEFING_POLL_WINDOW_DAYS": "2.5"})
    assert cfg == BriefingConfig(ai=False, rewrite_min_minutes=15, poll_window_days=2.5)
    bad = BriefingConfig.from_env({"LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES": "soon",
                                   "LEADMAKER_BRIEFING_POLL_WINDOW_DAYS": "-1"})
    assert (bad.rewrite_min_minutes, bad.poll_window_days) == (60, 7)  # unusable values fall back


# ---- briefing/v2 validator (AI review M1): numbers stay with what they count; places, alerts and names exist ----
V2_DIGEST = {"poll": {"highlights": [{"company_id": "c1", "name": "Carework Construction LLC", "kind": "tier_up",
                                      "text": "now GAF Master Elite (was GAF Certified)"}]},
             "weather": {"storm_response": []}, "leads": [{"id": "c1", "name": "Carework Construction LLC"}]}
V2_TEXT = ("Severe Thunderstorm Warning in Bergen County until 8 PM: 4 storm-restoration roofers there may need tarps "
           "and repair stock. Since Sunday's poll: 3 new leads, 5 changed across the team. Carework Construction LLC "
           "is now GAF Master Elite (was GAF Certified).")


@pytest.mark.parametrize("text,problem", [
    ("A Severe Thunderstorm Warning in Bergen County runs until 8 PM, and 4 storm-restoration roofers there may need "
     "tarps and repair stock. Since the last poll, 3 leads are new and 5 changed; Carework Construction LLC moved up "
     "to GAF Master Elite.", None),
    ("A Severe Thunderstorm Warning in Bergen County runs until 8 PM, and 5 storm-restoration roofers there may need "
     "repair stock. Since the last poll, 4 leads are new and 3 changed.", "numbers used for something else"),
    ("A Severe Thunderstorm Warning in Hudson County runs until 8 PM: 4 storm-restoration roofers may need tarps.",
     "county not in the digest: Hudson County"),
    ("A Tornado Warning in Bergen County runs until 8 PM: 4 storm-restoration roofers may need tarps.",
     "alert not in the digest: Tornado Warning"),
    ("Apex Roofing Solutions is now GAF Master Elite. A Severe Thunderstorm Warning in Bergen County runs until 8 PM.",
     "names something that is not in the digest: Apex Roofing Solutions"),
    ("Carework Construction LLC dropped to GAF Certified. A Severe Thunderstorm Warning in Bergen County runs until "
     "8 PM.", "tier change as a drop"),
    ("A Severe Thunderstorm Warning in Bergen County runs until 9 PM: 4 storm-restoration roofers may need tarps.",
     "a time that is not in the digest text"),
])
def test_validate_rewrite_v2(text, problem):
    violations = validate_rewrite({"text": text, "company_ids": ["c1"] if "Carework" in text else []}, V2_DIGEST,
                                  V2_TEXT)
    if problem is None:
        assert violations == []
    else:
        assert any(problem in v for v in violations), violations


def test_the_prompt_digest_holds_only_what_the_text_kept():
    """AI review M2: the text dropped the pool sentence (3-sentence cap) but the prompt still showed pool.new = 7, so a
    faithful-looking rewrite used 7 and was rejected on every run."""
    from leadmaker.briefing.rewrite import build_user_message, prompt_digest
    from leadmaker.briefing.text import render_digest_text

    d = {"v": 2, "scope": "team", "as_of": "2026-10-19T17:00:00Z", "book": {"leads": 150}, "quiet": False,
         "poll": {"run_id": 12, "finished_at": "2026-10-18T22:10:00Z", "fresh": True, "new": 3, "changed": 5,
                  "delisted": 0, "highlights": V2_DIGEST["poll"]["highlights"]},
         "pool": {"new": 7},
         "weather": {"alerts": [{"id": "urn:x", "county_fips": "34003", "county": "Bergen County, NJ",
                                 "event": "Severe Thunderstorm Warning", "level": "warning",
                                 "ends_at": "2026-10-20T00:00:00Z", "leads": 12}],
                     "alert_counties": 1, "alert_storm_leads": 4, "storm_response": [], "storm_response_total": 4,
                     "weather_delays_total": 2},
         "leads": V2_DIGEST["leads"]}
    text = render_digest_text(d)
    # v3: weather is the lowest priority, so the 3-sentence cap trims the alert and the delays (P, H, Q stay)
    assert "storm-restoration" not in text and "weather delays" not in text and "7 new" in text
    seen = prompt_digest(d)
    assert "alerts" not in seen["weather"] and "weather_delays_total" not in seen["weather"]
    assert "alert_storm_leads" not in seen["weather"] and seen["poll"]["new"] == 3 and seen["pool"] == {"new": 7}
    assert '"alert_storm_leads":4' not in build_user_message(d, text)
    # the template fake echoes the text, which always validates
    assert validate_rewrite({"text": text[:320], "company_ids": ["c1"]}, d, text) == []
