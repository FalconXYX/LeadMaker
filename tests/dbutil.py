"""Test helpers for the companies schema: demo users, GAF id <-> company id lookups, and records by GAF id."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from typing import Any

from leadmaker.db import Repository
from leadmaker.db.schema import users


def add_user(repo: Repository, name: str = "Rep One", role: str = "rep", email: str | None = None) -> str:
    """Insert a users row (the CRM side owns users; the pipeline only references them). Returns its id."""
    uid = str(uuid.uuid4())
    with repo.engine.begin() as conn:
        conn.execute(users.insert().values(id=uid, name=name, email=email or f"{uid[:8]}@test.local", role=role))
    return uid


def cid(repo: Repository, gaf_id: str | int) -> str:
    """Company id of a GAF contractor id (the test fails if it has none)."""
    company = repo.company_id(str(gaf_id))
    assert company is not None, f"no company for GAF id {gaf_id}"
    return company


def cids(repo: Repository, gaf_ids: Iterable[str | int]) -> list[str]:
    return [cid(repo, g) for g in gaf_ids]


def gaf_ids(repo: Repository, company_ids: Iterable[str]) -> list[str]:
    """GAF ids of company ids, in order."""
    return [r["gaf_id"] for r in repo.get_companies(list(company_ids))]


def leads_by_gaf(repo: Repository, gaf_ids: list[str] | None = None) -> list[dict[str, Any]]:
    """Lead records (Repository.get_companies), optionally only these GAF ids in that order."""
    if gaf_ids is None:
        return repo.get_companies()
    return repo.get_companies(cids(repo, gaf_ids))


def enrichments_by_gaf(repo: Repository, gaf_ids: list[str]) -> dict[str, dict[str, dict[str, Any]]]:
    """Repository.get_enrichments keyed by GAF id instead of company id."""
    by_company = repo.get_enrichments(cids(repo, gaf_ids))
    return {g: by_company.get(cid(repo, g), {}) for g in gaf_ids}


def with_gaf(repo: Repository, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows keyed by company_id (audit events, hits...) with each company's GAF id added."""
    gaf = {r["company_id"]: r["gaf_id"] for r in leads_by_gaf(repo)}
    return [{**r, "gaf_id": gaf.get(r["company_id"])} for r in rows]
