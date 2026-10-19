"""The SQLAlchemy mirror matches the migrated Postgres schema, and the pipeline never creates tables there."""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, Integer, Numeric, String, Text, Uuid, create_engine, text
from sqlalchemy.engine import make_url

from leadmaker.db import Repository
from leadmaker.db.repository import SchemaError
from leadmaker.db.schema import metadata

ROOT = Path(__file__).resolve().parents[2]

pytestmark = pytest.mark.pg

# GENERATED ... STORED columns (same list and reason as tests/test_schema_mirror.py): Postgres computes them,
# the pipeline never writes them, SQLite has no equivalent.
NOT_MIRRORED = {("companies", "location"), ("companies", "founded_year"), ("companies", "tag_facets")}
PG_TYPES = {
    Uuid: {"uuid"}, JSON: {"jsonb"}, Text: {"text"}, String: {"character varying", "character"},
    Float: {"double precision", "real"}, BigInteger: {"bigint"}, Integer: {"integer", "bigint"},
    Boolean: {"boolean"}, DateTime: {"timestamp with time zone"}, Numeric: {"numeric"},
}


def _pg_columns(engine) -> dict[str, dict[str, tuple[str, bool, int | None]]]:
    out: dict[str, dict[str, tuple[str, bool, int | None]]] = {}
    with engine.connect() as conn:
        for t, c, dtype, nullable, length in conn.execute(text(
                "SELECT c.table_name, c.column_name, c.data_type, c.is_nullable = 'YES', c.character_maximum_length "
                "FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name) "
                "WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' "
                "AND c.table_name NOT IN ('schema_migrations', 'spatial_ref_sys')")):
            out.setdefault(t, {})[c] = (dtype, nullable, length)
    return out


def _allowed(col) -> set[str]:
    typ = col.type
    impl = getattr(typ, "mapping", {}).get("postgresql", typ)  # with_variant: the type Postgres sees
    for cls, names in PG_TYPES.items():
        if isinstance(impl, cls):
            return names
    raise AssertionError(f"no Postgres type mapping for {col.table.name}.{col.name}: {typ!r}")


def test_unmirrored_columns_are_exactly_the_generated_ones(pg):
    with pg.engine.connect() as conn:
        generated = {tuple(r) for r in conn.execute(text(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND is_generated = 'ALWAYS'"))}
    assert generated == NOT_MIRRORED


def test_database_is_migrated_to_the_newest_file(pg):
    newest = max(p.name.split("_")[0] for p in (ROOT / "db" / "migrations").glob("*.sql"))
    with pg.engine.connect() as conn:
        assert conn.execute(text("SELECT max(version) FROM schema_migrations")).scalar() == newest


def test_mirror_matches_the_migrated_database(pg):
    live = _pg_columns(pg.engine)
    assert set(metadata.tables) == set(live)  # team_dashboard_kpis is a materialized view, not a table
    for table in metadata.sorted_tables:
        cols = live[table.name]
        assert set(cols) - {c for t, c in NOT_MIRRORED if t == table.name} == {c.name for c in table.columns}
        for col in table.columns:
            dtype, nullable, length = cols[col.name]
            assert dtype in _allowed(col), f"{table.name}.{col.name}: {dtype} vs mirror {col.type!r}"
            assert nullable == (col.nullable and not col.primary_key), f"{table.name}.{col.name} nullability"
            assert length == getattr(col.type, "length", None), f"{table.name}.{col.name} length"  # repository.fit


def test_repository_refuses_an_unmigrated_database(pg_url):
    name = make_url(pg_url).database.removesuffix("_test") + "_empty_test"
    admin = create_engine(make_url(pg_url).set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {name}"))
        conn.execute(text(f"CREATE DATABASE {name}"))
    empty_url = make_url(pg_url).set(database=name).render_as_string(hide_password=False)
    try:
        with pytest.raises(SchemaError, match="dbmate"):
            Repository(empty_url)
        probe = create_engine(empty_url)
        with probe.connect() as conn:  # nothing was created on the way
            n = conn.execute(text("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")).scalar()
        probe.dispose()
        assert n == 0
    finally:
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
        admin.dispose()
