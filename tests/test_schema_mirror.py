"""leadmaker/db/schema.py mirrors db/migrations (dbmate owns the Postgres schema): same tables, same columns,
same nullability, same string lengths (the pipeline trims scraped values to them). Parsed offline from the SQL
files (CREATE TABLE and ALTER TABLE ... ADD/DROP COLUMN, ALTER COLUMN ... DROP/SET NOT NULL); tests/pg/test_pg_schema.py checks a migrated database."""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

from leadmaker.db.schema import metadata

MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "migrations"
# GENERATED ... STORED columns: Postgres computes them, the pipeline never writes them, SQLite has no equivalent.
NOT_MIRRORED = {
    ("companies", "location"),  # geography from latitude/longitude
    ("companies", "founded_year"),  # LeadFilter search column (scraped_attributes, maturity tag, in_business_since)
    ("companies", "tag_facets"),  # LeadFilter search column (TEXT[] from system_tags)
}
CONSTRAINT_WORDS = {"PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT", "EXCLUDE"}
GENERATED = re.compile(r"\bGENERATED ALWAYS AS \(", re.I)  # not "AS IDENTITY"


def _uncomment(sql: str) -> str:
    return "\n".join(line.split("--")[0] for line in sql.splitlines())


def _items(body: str) -> list[str]:
    """Top-level comma-separated items of a CREATE/ALTER TABLE body (comments dropped, parentheses respected)."""
    text = _uncomment(body)
    items, depth, cur = [], 0, ""
    for ch in text:
        if ch == "," and depth == 0:
            items.append(cur)
            cur = ""
            continue
        depth += (ch == "(") - (ch == ")")
        cur += ch
    return [" ".join(i.split()) for i in [*items, cur] if i.strip()]


def _column_items() -> dict[str, dict[str, str]]:
    """{table: {column: definition}} from the up sections of db/migrations, in file order: every CREATE TABLE,
    then ALTER TABLE ... ADD COLUMN / DROP COLUMN."""
    tables: dict[str, dict[str, str]] = {}
    for path in sorted(MIGRATIONS.glob("*.sql")):
        up = path.read_text().split("-- migrate:down")[0]
        for name, body in re.findall(r"CREATE TABLE (\w+) \((.*?)\n\);", up, flags=re.S):
            tables[name] = {item.split()[0]: item for item in _items(body)
                            if item.split()[0].upper() not in CONSTRAINT_WORDS}
        for name, body in re.findall(r"\bALTER TABLE (?:ONLY )?(\w+)\s(.*?);", _uncomment(up), flags=re.S | re.I):
            for item in _items(body):
                if m := re.match(r"ADD COLUMN (?:IF NOT EXISTS )?(\w+) (.*)", item, flags=re.I):
                    tables[name][m.group(1)] = f"{m.group(1)} {m.group(2)}"
                elif m := re.match(r"DROP COLUMN (?:IF EXISTS )?(\w+)", item, flags=re.I):
                    tables[name].pop(m.group(1), None)
                elif m := re.match(r"ALTER COLUMN (\w+) (DROP|SET) NOT NULL$", item, flags=re.I):
                    col, op = m.group(1), m.group(2).upper()
                    item = re.sub(r"\s+NOT NULL\b", "", tables[name][col], flags=re.I)
                    tables[name][col] = item + (" NOT NULL" if op == "SET" else "")
    return tables


def generated_columns() -> set[tuple[str, str]]:
    return {(t, c) for t, cols in _column_items().items() for c, item in cols.items() if GENERATED.search(item)}


def migrated_tables() -> dict[str, dict[str, bool]]:
    """{table: {column: nullable}}."""
    return {t: {c: "NOT NULL" not in item.upper() and "PRIMARY KEY" not in item.upper() for c, item in cols.items()}
            for t, cols in _column_items().items()}


def migrated_lengths() -> dict[str, dict[str, int]]:
    """{table: {column: n}} for VARCHAR(n) / CHAR(n) columns."""
    out: dict[str, dict[str, int]] = {}
    for t, cols in _column_items().items():
        for c, item in cols.items():
            m = re.match(r"\w+ (?:VARCHAR|CHAR)\((\d+)\)", item, flags=re.I)
            if m:
                out.setdefault(t, {})[c] = int(m.group(1))
    return out


def test_migrations_parse():
    tables = migrated_tables()
    assert {"companies", "company_source_ids", "contacts", "outbox_events", "jobs"} <= set(tables)
    assert tables["companies"]["business_name"] is False and tables["companies"]["website_url"] is True
    assert {"founded_year", "tag_facets"} <= set(tables["companies"])  # ALTER TABLE ... ADD COLUMN


def test_alter_table_columns_are_parsed(tmp_path, monkeypatch):
    (tmp_path / "1_t.sql").write_text(
        "-- migrate:up\nCREATE TABLE t (\n    id INT PRIMARY KEY,\n    old_col TEXT\n);\n"
        "ALTER TABLE t\n    -- a comment, with a comma\n    ADD COLUMN a VARCHAR(12) NOT NULL DEFAULT 'x',\n"
        "    ADD COLUMN IF NOT EXISTS g INT GENERATED ALWAYS AS (length(coalesce(old_col, ','))) STORED,\n"
        "    DROP COLUMN old_col;\nALTER TABLE t ALTER COLUMN a DROP NOT NULL;\n"
        "ALTER TABLE t ADD COLUMN b INT;\nALTER TABLE t ALTER COLUMN b SET NOT NULL;\n"
        "-- migrate:down\nALTER TABLE t ADD COLUMN ignored INT;\n")
    monkeypatch.setattr(sys.modules[__name__], "MIGRATIONS", tmp_path)
    assert migrated_tables() == {"t": {"id": False, "a": True, "g": True, "b": False}}
    assert migrated_lengths() == {"t": {"a": 12}}
    assert generated_columns() == {("t", "g")}


def test_unmirrored_columns_are_exactly_the_generated_ones():
    """A new GENERATED column must be added to NOT_MIRRORED here and in tests/pg/test_pg_schema.py (and the
    schema.py docstring); any other new column must be mirrored."""
    assert generated_columns() == NOT_MIRRORED


def test_every_migrated_table_is_mirrored_and_nothing_else():
    assert set(metadata.tables) == set(migrated_tables())


@pytest.mark.parametrize("table", sorted(migrated_tables()))
def test_columns_and_nullability_match(table):
    sql = migrated_tables()[table]
    mirror = metadata.tables[table]
    assert set(sql) - {c for t, c in NOT_MIRRORED if t == table} == {c.name for c in mirror.columns}
    for col in mirror.columns:
        nullable = col.nullable and not col.primary_key
        assert nullable == sql[col.name], f"{table}.{col.name}: mirror nullable={nullable}, migration={sql[col.name]}"


def test_string_lengths_match():
    """repository.fit trims scraped strings to the mirror's lengths: a longer one would be refused by Postgres."""
    sql = migrated_lengths()
    assert sql["companies"]["phone"] == 32 and sql["companies"]["county_fips"] == 5
    for table in metadata.sorted_tables:
        mirror = {c.name: c.type.length for c in table.columns if getattr(c.type, "length", None)}
        assert mirror == sql.get(table.name, {}), table.name
