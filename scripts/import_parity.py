#!/usr/bin/env python3
"""Check that `leadmaker import-sqlite` carried a Section 1 SQLite database into Postgres without loss.

    .venv/bin/python scripts/import_parity.py SQLITE_PATH POSTGRES_URL

POSTGRES_URL may be in libpq (postgres://...) or SQLAlchemy (postgresql+psycopg://...) form. The target
must hold only that import (one or more runs of it, nothing else): every source row is matched to its
target row and compared column by column, and anything extra in the target is reported. Prints one
row per check and exits 1 if any check fails. Reads both databases; writes neither.

Independent of leadmaker/db/import_sqlite.py on purpose: legacy columns are decoded from their declared
SQLite types, and every legacy column must be either compared or listed below as intentionally replaced.
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

import psycopg
from psycopg.rows import dict_row

GAF = "gaf"
IMPORT_KIND = "sqlite_import"
SAMPLES = 3

# legacy column -> target column; None = intentionally not carried as a column (reason given).
RENAMES = {
    "contractors": {"name": "business_name", "website": "website_url", "tags": "system_tags", "gaf_id": None},
    "contacts": {"gaf_id": "company_id", "id": None},
    "enrichments": {"gaf_id": "company_id", "confidence": "match_confidence"},
    "reviews": {"gaf_id": "company_id"},
    "audit_events": {"gaf_id": "company_id", "entity_type": None, "entity_id": None},
    "search_hits": {"gaf_id": "company_id"},
    "accounts": {"gaf_id": "company_id"},
    "regional_signals": {"id": None},
}
REPLACED = {
    ("contractors", "gaf_id"): "company_source_ids (source 'gaf')",
    ("contacts", "id"): "new uuid + source_key",
    ("regional_signals", "id"): "new uuid; keyed by (source, external_id, county_fips)",
    ("audit_events", "entity_type"): "compared with contractor -> company",
    ("audit_events", "entity_id"): "re-keyed; checked by 'audit entity links'",
}
NOT_COMPARED = {("jobs", "dedupe_key"): "canonicalised", ("jobs", "requested_by"): "cleared unless a known user"}
TABLES = ("contractors", "contacts", "enrichments", "reviews", "audit_events", "regional_signals", "scrape_runs",
          "search_hits", "jobs", "schedules", "accounts")


def canon(v: Any) -> Any:
    """Comparable form of a value from either side."""
    if isinstance(v, (dict, list)):
        return "json:" + json.dumps(v, sort_keys=True)
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    if isinstance(v, str) and v.startswith("json:"):
        return "str:" + v
    return v


def show(v: Any) -> str:
    s = v.isoformat() if isinstance(v, datetime) else repr(v)
    return s if len(s) <= 60 else s[:57] + "..."


def _decode(v: Any, decl: str) -> Any:
    if v is None:
        return None
    if decl == "JSON":
        return json.loads(v) if isinstance(v, (str, bytes)) else v
    if decl in ("DATETIME", "TIMESTAMP"):
        return datetime.fromisoformat(str(v))
    if decl == "BOOLEAN":
        return bool(v)
    return v


def read_sqlite(path: Path) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[str]]]:
    conn = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        have = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        rows: dict[str, list[dict[str, Any]]] = {}
        cols: dict[str, list[str]] = {}
        for t in TABLES:
            if t not in have:
                rows[t], cols[t] = [], []
                continue
            decl = {r["name"]: (r["type"] or "").upper() for r in conn.execute(f"PRAGMA table_info({t})")}
            cols[t] = list(decl)
            rows[t] = [{k: _decode(r[k], decl[k]) for k in r.keys()} for r in conn.execute(f"SELECT * FROM {t}")]
    finally:
        conn.close()
    return rows, cols


def pg_url(url: str) -> str:
    scheme, sep, rest = url.partition("://")
    return ("postgresql" if scheme.startswith("postgres") else scheme) + sep + rest


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, list[str]]] = []

    def add(self, name: str, ok: bool | None, detail: str, samples: list[str] | None = None) -> None:
        self.rows.append((name, "INFO" if ok is None else "PASS" if ok else "FAIL", detail, samples or []))

    @property
    def failed(self) -> int:
        return sum(r[1] == "FAIL" for r in self.rows)

    def print(self) -> None:
        w = max(len(r[0]) for r in self.rows)
        print(f"{'CHECK':<{w}}  RESULT  DETAIL")
        print(f"{'-' * w}  ------  {'-' * 60}")
        for name, res, detail, samples in self.rows:
            print(f"{name:<{w}}  {res:<6}  {detail}")
            for s in samples[:SAMPLES]:
                print(f"{'':<{w}}          - {s if len(s) <= 160 else s[:157] + '...'}")
        print(f"\n{len(self.rows) - self.failed}/{len(self.rows)} checks passed"
              + (f", {self.failed} FAILED" if self.failed else ""))


def compare_keyed(rep: Report, name: str, legacy: dict[Any, dict[str, Any]], target: dict[Any, dict[str, Any]],
                  fields: list[tuple[str, str]], label: str = "rows", allow_extra: Callable[[Any], bool] | None = None,
                  close: set[str] = frozenset()) -> None:
    """Every legacy row present once in the target with equal fields; nothing unexplained added."""
    missing = [k for k in legacy if k not in target]
    extra = [k for k in target if k not in legacy and not (allow_extra and allow_extra(target[k]))]
    diffs: list[str] = []
    bad = 0
    for k, old in legacy.items():
        new = target.get(k)
        if new is None:
            continue
        d = []
        for lc, tc in fields:
            a, b = canon(old.get(lc)), canon(new.get(tc))
            if lc in close and a is not None and b is not None:
                eq = math.isclose(a, b, rel_tol=0, abs_tol=1e-9)
            else:
                eq = a == b
            if not eq:
                d.append(f"{lc}: {show(a)} != {show(b)}")
        if d:
            bad += 1
            diffs.append(f"{k}: " + "; ".join(d[:3]))
    ok = not (missing or extra or bad)
    detail = f"{len(legacy)} {label} in source, {len(target)} in target"
    if not ok:
        detail += f"; missing {len(missing)}, unexpected {len(extra)}, differing {bad}"
    samples = [f"missing {k}" for k in missing[:SAMPLES]] + [f"unexpected {k}" for k in extra[:SAMPLES]] + diffs
    rep.add(name, ok, detail, samples)


def compare_counts(rep: Report, name: str, legacy: Counter, target: Counter, label: str) -> None:
    lost, added = legacy - target, target - legacy
    ok = not lost and not added
    detail = (f"{sum(legacy.values())} {label} over {len(legacy)} groups in source, "
              f"{sum(target.values())} over {len(target)} in target")
    samples = [f"{k}: source {legacy[k]}, target {target[k]}" for k in list(lost) + list(added)]
    rep.add(name, ok, detail, samples)


def same_fields(table: str, legacy_cols: list[str], target_cols: set[str]) -> list[tuple[str, str]]:
    """(legacy key, target column) pairs; gaf_id compares as the company_id the caller resolved into the row."""
    ren = RENAMES.get(table, {})
    out = []
    for c in legacy_cols:
        t = ren.get(c, c)
        if t is None or (table, c) in NOT_COMPARED:
            continue
        out.append(("company_id" if c == "gaf_id" else c, t))
    return [(c, t) for c, t in out if t in target_cols]


def run(sqlite_path: Path, url: str) -> Report:
    rep = Report()
    legacy, lcols = read_sqlite(sqlite_path)
    with psycopg.connect(pg_url(url), row_factory=dict_row) as pg:
        def q(sql: str, *params: Any) -> list[dict[str, Any]]:
            return pg.execute(sql, params).fetchall()

        tcols: dict[str, set[str]] = defaultdict(set)
        for r in q("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"):
            tcols[r["table_name"]].add(r["column_name"])

        # ---- schema coverage: every legacy column is compared or deliberately replaced
        uncovered = []
        for t in TABLES:
            ren = RENAMES.get(t, {})
            for c in lcols[t]:
                tgt = ren.get(c, c)
                if tgt is None:
                    if (t, c) not in REPLACED:
                        uncovered.append(f"{t}.{c} (dropped without a reason)")
                elif tgt not in tcols.get(t if t != "contractors" else "companies", set()):
                    uncovered.append(f"{t}.{c} -> no target column {tgt}")
        rep.add("legacy columns covered", not uncovered,
                f"{sum(len(c) for c in lcols.values())} legacy columns; {len(REPLACED)} replaced by design "
                f"({', '.join(f'{t}.{c}' for t, c in REPLACED)})" if not uncovered else f"{len(uncovered)} uncovered",
                uncovered)

        # ---- companies <-> GAF ids
        links = q("SELECT external_id, company_id::text AS company_id FROM company_source_ids WHERE source = %s", GAF)
        gmap = {r["external_id"]: r["company_id"] for r in links}
        per_company = Counter(r["company_id"] for r in links)
        n_companies = q("SELECT count(*) AS n FROM companies")[0]["n"]
        contractors = {str(c["gaf_id"]): c for c in legacy["contractors"]}
        rep.add("contractors -> companies", len(contractors) == len(per_company) == n_companies,
                f"{len(contractors)} contractors, {len(per_company)} companies with a gaf id, "
                f"{n_companies} companies total")
        missing = [g for g in contractors if g not in gmap]
        extra = [g for g in gmap if g not in contractors]
        multi = [c for c, n in per_company.items() if n > 1]
        rep.add("every gaf id exactly once", not (missing or extra or multi),
                f"{len(contractors)} gaf ids; missing {len(missing)}, not in source {len(extra)}, "
                f"companies with >1 gaf id {len(multi)}",
                [f"missing {g}" for g in missing] + [f"not in source {g}" for g in extra]
                + [f"company {c}" for c in multi])
        other_sources = q("SELECT source, count(*) AS n FROM company_source_ids WHERE source <> %s GROUP BY 1", GAF)
        if other_sources:
            rep.add("other company_source_ids", False, ", ".join(f"{r['source']}: {r['n']}" for r in other_sources))

        comp = {r["id"]: r for r in q(
            "SELECT c.*, c.id::text AS id, ST_Y(location::geometry) AS loc_lat, ST_X(location::geometry) AS loc_lon "
            "FROM companies c")}
        by_gaf = {g: comp[cid] for g, cid in gmap.items() if cid in comp}
        legacy_c = {}
        for g, c in contractors.items():
            c = dict(c)
            c["loc_lat"], c["loc_lon"] = c.get("latitude"), c.get("longitude")
            ps = c.get("priority_score")
            c["priority_score"] = round(float(ps), 1) if ps is not None else None
            legacy_c[g] = c
        lossy = [g for g, c in contractors.items() if c.get("priority_score") is not None
                 and round(float(c["priority_score"]), 1) != float(c["priority_score"])]
        ren = RENAMES["contractors"]

        def fields(*cols: str) -> list[tuple[str, str]]:
            return [(c, ren.get(c, c)) for c in cols]

        groups = [
            ("name", fields("name")), ("phone", fields("phone")), ("website", fields("website")),
            ("address", fields("address", "street", "city", "state", "postal_code", "country")),
            ("rating", fields("rating")), ("review count", fields("review_count")),
            ("certifications", fields("certifications")), ("tier", fields("tier", "tier_rank")),
            ("system tags", fields("tags")), ("segment", fields("segment")),
            ("county_fips", fields("county_fips")),
        ]
        used = {c for _, fs in groups for c, _ in fs} | {"latitude", "longitude", "priority_score", "gaf_id"}
        for name, fs in groups:
            compare_keyed(rep, f"company {name}", legacy_c, by_gaf, fs, "companies")
        compare_keyed(rep, "company lat/lon -> location", legacy_c, by_gaf,
                      [(c, c) for c in ("latitude", "longitude", "loc_lat", "loc_lon")],
                      "companies", close={"loc_lat", "loc_lon"})
        compare_keyed(rep, "company priority_score", legacy_c, by_gaf, fields("priority_score"), "companies")
        if lossy:
            rep.add("priority_score precision", False, f"{len(lossy)} scores had more than 1 decimal (NUMERIC(4,1))",
                    [f"{g}: {contractors[g]['priority_score']}" for g in lossy])
        rest = [(c, ren.get(c, c)) for c in lcols["contractors"] if c not in used and ren.get(c, c)]
        compare_keyed(rep, "company other columns", legacy_c, by_gaf, rest, "companies")
        rep.add("company other columns: list", None, ", ".join(c for c, _ in rest))

        # ---- contacts
        tcon = q("SELECT *, company_id::text AS company_id FROM contacts")
        cid_gaf = {cid: g for g, cid in gmap.items()}
        compare_counts(rep, "contacts per source per company",
                       Counter((str(r["gaf_id"]), r["source"]) for r in legacy["contacts"]),
                       Counter((cid_gaf.get(r["company_id"], r["company_id"]), r["source"]) for r in tcon), "contacts")
        cf = [c for c, t in same_fields("contacts", lcols["contacts"], tcols["contacts"]) if c != "company_id"]
        compare_counts(rep, "contact fields", Counter((str(r["gaf_id"]),) + tuple(canon(r[c]) for c in cf)
                                                      for r in legacy["contacts"]),
                       Counter((cid_gaf.get(r["company_id"], r["company_id"]),) + tuple(canon(r[c]) for c in cf)
                               for r in tcon), "contacts")
        dupe_keys = [k for k, n in Counter(r["source_key"] for r in tcon).items() if n > 1 or k is None]
        rep.add("contact source_key unique", not dupe_keys,
                f"{len(tcon)} contacts, {len(dupe_keys)} duplicate/NULL keys")

        # ---- enrichments
        tenr = q("SELECT *, company_id::text AS company_id FROM enrichments")
        compare_counts(rep, "enrichments per source+status",
                       Counter((r["source"], r["status"]) for r in legacy["enrichments"]),
                       Counter((r["source"], r["status"]) for r in tenr), "enrichments")
        compare_keyed(rep, "enrichment rows",
                      {(str(r["gaf_id"]), r["source"]): r for r in legacy["enrichments"]},
                      {(cid_gaf.get(r["company_id"], r["company_id"]), r["source"]): r for r in tenr},
                      [(c, t) for c, t in same_fields("enrichments", lcols["enrichments"], tcols["enrichments"])
                       if c != "company_id"])

        # ---- reviews
        trev = q("SELECT *, company_id::text AS company_id FROM reviews")
        lrev = {r["id"]: dict(r, company_id=gmap.get(str(r["gaf_id"]))) for r in legacy["reviews"]}
        compare_keyed(rep, "reviews", lrev, {r["id"]: r for r in trev},
                      same_fields("reviews", lcols["reviews"], tcols["reviews"]))

        # ---- regional signals
        tsig = q("SELECT * FROM regional_signals")
        compare_counts(rep, "regional_signals per source", Counter(r["source"] for r in legacy["regional_signals"]),
                       Counter(r["source"] for r in tsig), "signals")
        sig_key = ("source", "external_id", "county_fips")
        compare_keyed(rep, "regional_signals rows",
                      {tuple(r[k] for k in sig_key): r for r in legacy["regional_signals"]},
                      {tuple(r[k] for k in sig_key): r for r in tsig},
                      same_fields("regional_signals", lcols["regional_signals"], tcols["regional_signals"]))

        # ---- runs and the import's own run
        truns = {r["id"]: r for r in q("SELECT * FROM scrape_runs")}
        imports = [r for r in truns.values() if r["kind"] == IMPORT_KIND]
        compare_keyed(rep, "scrape_runs (ids kept)", {r["id"]: r for r in legacy["scrape_runs"]}, truns,
                      same_fields("scrape_runs", lcols["scrape_runs"], tcols["scrape_runs"]),
                      allow_extra=lambda r: r["kind"] == IMPORT_KIND)
        import_run_ids = {r["id"] for r in imports}
        rep.add("one import run", len(imports) == (1 if contractors else 0),
                f"{len(imports)} '{IMPORT_KIND}' run(s): ids {sorted(import_run_ids)}"
                + (f", imported {[r['stats'].get('companies') for r in imports]}" if imports else ""))

        lhits = {r["id"]: dict(r, company_id=gmap.get(str(r["gaf_id"]))) for r in legacy["search_hits"]}
        thits = q("SELECT *, company_id::text AS company_id FROM search_hits")
        compare_keyed(rep, "search_hits (ids kept)", lhits, {r["id"]: r for r in thits},
                      same_fields("search_hits", lcols["search_hits"], tcols["search_hits"]))

        # ---- audit
        taud = {r["id"]: r for r in q("SELECT *, company_id::text AS company_id FROM audit_events")}
        laud = {}
        for e in legacy["audit_events"]:
            et = "company" if e["entity_type"] == "contractor" else e["entity_type"]
            laud[e["id"]] = dict(e, entity_type=et, company_id=gmap.get(str(e["gaf_id"])) if e.get("gaf_id") else None)
        own = {k: r for k, r in taud.items() if k not in laud and r["run_id"] in import_run_ids}
        compare_keyed(rep, "audit events (ids kept)", laud, taud,
                      [("entity_type", "entity_type")]
                      + same_fields("audit_events", lcols["audit_events"], tcols["audit_events"]),
                      allow_extra=lambda r: r["run_id"] in import_run_ids)
        own_ok = len(own) == len(per_company) and all(
            r["entity_type"] == "company" and r["action"] == "created" and r["entity_id"] == r["company_id"]
            for r in own.values())
        carried = sum(k in taud for k in laud)
        rep.add("audit events count", len(taud) == len(laud) + len(own) and own_ok,
                f"{len(laud)} in source; {len(taud)} in target = {carried} carried + {len(own)} import 'created' "
                f"events (expected one per company: {len(per_company)})")

        # Each audit event that pointed at a live row (company, enrichment, contact) still does, under the new key.
        live_contacts = {r["id"]: str(r["gaf_id"]) for r in legacy["contacts"]}
        tkeys = {r["source_key"]: r["company_id"] for r in tcon}
        lost_links = []
        n_links = 0
        for k, e in laud.items():
            t = taud.get(k)
            if t is None:
                continue
            g, eid = (str(e["gaf_id"]) if e.get("gaf_id") else None), str(e["entity_id"])
            if e["entity_type"] in ("company", "profile", "tags", "reviews", "area") and g in gmap:
                want = t["entity_id"] == gmap[g]
            elif e["entity_type"] == "enrichment" and g in gmap and ":" in eid:
                want = t["entity_id"] == f"{gmap[g]}:{eid.split(':', 1)[1]}"
            elif e["entity_type"] == "contact" and live_contacts.get(eid) == g and g in gmap:
                want = tkeys.get(t["entity_id"]) == gmap[g]
            else:
                continue
            n_links += 1
            if not want:
                lost_links.append(f"audit {k} ({e['entity_type']} {eid}) -> {t['entity_id']}")
        rep.add("audit entity links", not lost_links,
                f"{n_links} events pointing at a live company/enrichment/contact; {len(lost_links)} lost the link",
                lost_links)

        # ---- jobs / schedules / accounts: carried over by the importer (ids kept)
        for table, key in (("jobs", "id"), ("schedules", "id"), ("accounts", "account_id")):
            lrows = {r[key]: dict(r, company_id=gmap.get(str(r["gaf_id"]))) if "gaf_id" in r else r
                     for r in legacy[table]}
            trows = {r[key]: r for r in q(f"SELECT * FROM {table}")}
            for r in trows.values():
                if r.get("company_id") is not None:
                    r["company_id"] = str(r["company_id"])
            compare_keyed(rep, f"{table} (carried over)", lrows, trows,
                          same_fields(table, lcols[table], tcols[table]))
        rep.add("jobs: not compared", None, "; ".join(f"{t}.{c} {why}" for (t, c), why in NOT_COMPARED.items()))

        # ---- events the import published (re-running must not add more)
        ev = q("SELECT event_type, count(*) AS n, count(DISTINCT company_id) AS companies FROM outbox_events "
               "WHERE payload->>'run_id' = ANY(%s) "
               "OR (event_type = 'pipeline.run_completed' AND payload->>'kind' = %s) "
               "GROUP BY 1", [str(i) for i in import_run_ids], IMPORT_KIND)
        evs = {r["event_type"]: r for r in ev}
        lu, done = evs.get("lead.updated"), evs.get("pipeline.run_completed")
        others = q("SELECT count(*) AS n FROM outbox_events")[0]["n"] - sum(r["n"] for r in ev)
        n_lu, n_lu_companies, n_done = (lu or {}).get("n", 0), (lu or {}).get("companies", 0), (done or {}).get("n", 0)
        ok = n_lu == n_lu_companies == len(per_company) and n_done == len(imports)
        rep.add("outbox events", ok and others == 0,
                f"lead.updated {n_lu} for {n_lu_companies} companies, pipeline.run_completed {n_done}, other {others}")

        st = q("SELECT count(*) FILTER (WHERE updated_in_last_poll) AS poll, count(last_material_change_at) AS mat, "
               "count(*) FILTER (WHERE assigned_rep_id IS NOT NULL) AS assigned, "
               "string_agg(DISTINCT account_status, ',') AS statuses FROM companies")[0]
        rep.add("derived lead state", None,
                f"updated_in_last_poll {st['poll']}/{n_companies}, last_material_change_at set {st['mat']}, "
                f"assigned {st['assigned']}, account_status {st['statuses']}")
    return rep


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("sqlite_path", type=Path)
    p.add_argument("postgres_url")
    args = p.parse_args(argv)
    if not args.sqlite_path.is_file():
        print(f"no such file: {args.sqlite_path}", file=sys.stderr)
        return 2
    rep = run(args.sqlite_path, args.postgres_url)
    rep.print()
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
