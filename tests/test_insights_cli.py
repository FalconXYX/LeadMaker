"""`leadmaker insights ...`: parsing, the Section 1 seed-file guard, a fake run, `show`, `schedule`, and the
`schedule add --params` / `jobs enqueue insights` additions."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from leadmaker.cli import build_parser, main
from leadmaker.db import Repository
from leadmaker.insights.cli import SEED_FILE_MESSAGE, is_seed_file
from leadmaker.jobs import JobQueue

from test_insights_support import seeded

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "leadmaker.db"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("LEADMAKER_DATABASE_URL", "DATABASE_URL", "LEADMAKER_INSIGHTS_BATCH_SIZE", "LEADMAKER_FAKE_LLM_SCRIPT",
              "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "LEADMAKER_LLM_BASE_URL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("LEADMAKER_LLM_PROVIDER", "fake")
    monkeypatch.setenv("LEADMAKER_LLM_USAGE_FILE", "")


@pytest.fixture
def db(tmp_path) -> str:
    return f"sqlite:///{tmp_path / 'cli.db'}"


def run_cli(capsys, *argv: str) -> tuple[int, str, str]:
    rc = main(list(argv))
    out = capsys.readouterr()
    return rc, out.out, out.err


def test_parsing():
    a = build_parser().parse_args(["insights", "--stale", "--zip", "07030", "--radius", "10", "--company", "a",
                                   "--company", "b", "--limit", "5", "--batch-size", "3", "--force", "--dry-run"])
    assert (a.stale, a.postal_code, a.radius_miles, a.company_id, a.limit, a.batch_size, a.force, a.dry_run) == (
        True, "07030", 10.0, ["a", "b"], 5, 3, True, True)
    assert a.insights_cmd is None
    a = build_parser().parse_args(["insights", "show", "--company", "x"])
    assert a.insights_cmd == "show" and a.show_company == "x"
    a = build_parser().parse_args(["insights", "schedule", "--every-hours", "0.25"])
    assert a.insights_cmd == "schedule" and a.every_hours == 0.25
    assert build_parser().parse_args(["briefing"]).command == "briefing"  # BRIEFING's command, registered here


@pytest.mark.parametrize("argv", [["insights"], ["insights", "--dry-run"], ["--db", f"sqlite:///{SEED}", "insights"],
                                  ["--db", "sqlite:///data/leadmaker.db", "insights", "show", "--company", "x"]])
def test_refuses_the_section_1_seed_file(capsys, argv):
    before = SEED.stat().st_mtime_ns if SEED.exists() else None
    rc, out, err = run_cli(capsys, *argv)
    assert rc == 2 and SEED_FILE_MESSAGE in err and out == ""
    assert (SEED.stat().st_mtime_ns if SEED.exists() else None) == before


def test_is_seed_file(tmp_path, monkeypatch):
    assert is_seed_file("sqlite:///data/leadmaker.db") and is_seed_file(f"sqlite:///{SEED}")
    assert not is_seed_file(f"sqlite:///{tmp_path / 'leadmaker.db'}")
    assert not is_seed_file("sqlite://") and not is_seed_file("sqlite:///:memory:")
    assert not is_seed_file("postgresql+psycopg://u:p@localhost:55432/leadmaker")
    monkeypatch.chdir(tmp_path)  # a relative path is resolved against the working directory too
    assert is_seed_file("sqlite:///./data/leadmaker.db")


def test_a_fake_run_then_show(capsys, db):
    ids = seeded(Repository(db))
    rc, out, _ = run_cli(capsys, "--db", db, "insights", "--limit", "5", "--batch-size", "5")
    res = json.loads(out)
    assert rc == 0 and res["status"] == "succeeded" and res["generated"] == 5 and res["llm_calls"] == 1
    rc, out, _ = run_cli(capsys, "--db", db, "insights", "--limit", "5")
    res = json.loads(out)
    assert res["skipped_unchanged"] == 5 and res["llm_calls"] == 1 and res["generated"] == 1  # the 6th lead
    rc, out, _ = run_cli(capsys, "--db", db, "insights")
    res = json.loads(out)
    assert res["skipped_unchanged"] == 6 and res["llm_calls"] == 0 and res["generated"] == 0
    rc, out, _ = run_cli(capsys, "--db", db, "insights", "show", "--company", ids[0])
    row = json.loads(out)
    assert rc == 0 and row["company_id"] == ids[0] and row["status"] == "ok" and row["sales_recommendation"]
    rc, out, _ = run_cli(capsys, "--db", db, "insights", "show", "--company", "nope")
    assert rc == 1 and json.loads(out) is None


def test_dry_run_and_no_provider(capsys, db, monkeypatch):
    seeded(Repository(db))
    rc, out, _ = run_cli(capsys, "--db", db, "insights", "--dry-run", "--zip", "10013")
    res = json.loads(out)
    assert rc == 0 and res["status"] == "dry_run" and res["to_generate"] == 6 and res["estimated_llm_calls"] == 6
    monkeypatch.setenv("LEADMAKER_LLM_PROVIDER", "auto")
    rc, out, err = run_cli(capsys, "--db", db, "insights")
    assert rc == 1 and json.loads(out)["reason"] == "no_provider" and "insights skipped" in err


def test_the_output_never_shows_keys(capsys, db, monkeypatch):
    seeded(Repository(db))
    monkeypatch.setenv("GEMINI_API_KEY", "AIzaSyTESTKEY-not-real-0123456789")
    rc, out, err = run_cli(capsys, "--db", db, "insights", "--dry-run")
    assert rc == 0 and "AIza" not in out + err


def test_schedules_and_jobs(capsys, db):
    repo = Repository(db)
    rc, out, _ = run_cli(capsys, "--db", db, "insights", "schedule", "--every-hours", "0.25")
    assert rc == 0 and json.loads(out)["name"] == "insights-stale"
    rc, _, _ = run_cli(capsys, "--db", db, "schedule", "add", "--name", "nightly-insights", "--kind", "insights",
                       "--every-hours", "24", "--params", '{"stale": true, "limit": 50}')
    rc2, _, _ = run_cli(capsys, "--db", db, "schedule", "add", "--name", "area-insights", "--kind", "insights",
                        "--every-hours", "24", "--zip", "07030", "--params", '{"batch_size": 5}')
    rc3, _, err = run_cli(capsys, "--db", db, "schedule", "add", "--name", "x", "--kind", "insights",
                          "--every-hours", "1", "--params", "[1]")
    assert (rc, rc2, rc3) == (0, 0, 2) and "--params must be a JSON object" in err
    sched = {s["name"]: s for s in JobQueue(repo).list_schedules()}
    assert sched["insights-stale"]["params"] == {"stale": True} and sched["insights-stale"]["kind"] == "insights"
    assert sched["nightly-insights"]["params"] == {"stale": True, "limit": 50}
    assert sched["area-insights"]["params"] == {"postal_code": "07030", "radius_miles": 25.0, "batch_size": 5}
    rc, out, _ = run_cli(capsys, "--db", db, "jobs", "enqueue", "insights", "--zip", "10013", "--radius", "25")
    assert rc == 0 and len(json.loads(out)["enqueued"]) == 1
    rc, out, _ = run_cli(capsys, "--db", db, "jobs", "enqueue", "briefing")
    assert rc == 0 and len(json.loads(out)["enqueued"]) == 1
    queued = {j["kind"]: j for j in JobQueue(repo).list("queued")}
    assert queued["insights"]["params"] == {"postal_code": "10013", "radius_miles": 25.0}
    assert queued["insights"]["dedupe_key"] == "insights:10013:25:*" and queued["briefing"]["params"] == {}
