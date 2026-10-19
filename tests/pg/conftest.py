"""Postgres integration tests (marked `pg`, excluded by default): `pytest -m pg`.

They run against the compose Postgres (`npm run db:up`), on their own database so they never touch the
shared `leadmaker` data or another package's test database:

    LEADMAKER_PG_TEST_URL   default postgresql+psycopg://leadmaker:leadmaker@localhost:55432/leadmaker_pipeline_test

Once per session the database is created if missing and migrated to the newest file with the project's
dbmate (scripts/dbmate.sh --db NAME up), so the tests never run on an older schema; a failed migration
fails the session. Every table is truncated before each test, so the name must end in `_test`.
Each module sets `pytestmark = pytest.mark.pg`.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from leadmaker.db import Repository
from leadmaker.db.repository import normalize_url
from leadmaker.db.schema import REQUIRED_TABLES

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_URL = "postgresql+psycopg://leadmaker:leadmaker@localhost:55432/leadmaker_pipeline_test"
PG_URL = normalize_url(os.environ.get("LEADMAKER_PG_TEST_URL") or DEFAULT_URL)


def _server_up(url: str) -> bool:
    engine = create_engine(make_url(url).set(database="postgres"))
    try:
        with engine.connect():
            return True
    except Exception:
        return False
    finally:
        engine.dispose()


def _missing_tables(url: str) -> list[str]:
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            have = set(conn.execute(text(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).scalars())
    finally:
        engine.dispose()
    return [t for t in REQUIRED_TABLES if t not in have]


@pytest.fixture(scope="session")
def pg_url() -> str:
    name = make_url(PG_URL).database or ""
    if not name.endswith("_test"):
        pytest.exit(f"refusing to run the pg tests on {name!r}: they truncate every table (name must end in _test)")
    if not _server_up(PG_URL):
        pytest.skip(f"compose Postgres not reachable for {name}; run `npm run db:up` first")
    try:
        subprocess.run(["sh", "scripts/dbmate.sh", "--db", name, "--wait", "up"], cwd=ROOT, check=True,
                       capture_output=True, text=True, timeout=180)
    except subprocess.CalledProcessError as e:
        pytest.fail(f"dbmate up failed on {name}: {(e.stderr or e.stdout or '').strip()[-2000:]}", pytrace=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        pytest.fail(f"could not run dbmate for {name}: {e}", pytrace=False)
    missing = _missing_tables(PG_URL)
    if missing:
        pytest.fail(f"{name} is missing tables {missing} after dbmate up", pytrace=False)
    return PG_URL


@pytest.fixture
def pg(pg_url) -> Repository:
    """A Repository on the pg test database, with every table empty and identities restarted."""
    repo = Repository(pg_url)
    with repo.engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {', '.join(REQUIRED_TABLES)} RESTART IDENTITY CASCADE"))
    yield repo
    repo.engine.dispose()
