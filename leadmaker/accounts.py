"""Import the distributor's customer list (CRM export) and match it to GAF contractors.

This is what turns a lead list into account planning: each contractor becomes an
existing customer, a lapsed customer, or a net-new prospect (Section 0:
"net-new prospecting and existing account management", "account status" filter).

CSV headers are matched loosely (e.g. "Account Name"/"Customer"/"name", "Zip"/
"postal_code", "Phone"/"Main Phone", "Status", "Sales Rep"/"owner", "Annual
Spend"/"TTM Sales", "Last Order Date").
"""

from __future__ import annotations

import csv
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select

from .db import Repository
from .db.repository import as_utc, utcnow
from .db.schema import accounts, contractors
from .enrich.matching import name_similarity, phone_digits, zip5

HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "account_id": ("account_id", "account id", "account number", "customer id", "customer number", "id", "acct"),
    "name": ("name", "account name", "customer", "customer name", "company", "company name", "business name"),
    "phone": ("phone", "main phone", "phone number", "telephone"),
    "postal_code": ("postal_code", "zip", "zip code", "zipcode", "postal code"),
    "city": ("city",),
    "state": ("state", "st"),
    "status": ("status", "account status", "customer status"),
    "owner_rep": ("owner_rep", "owner", "sales rep", "rep", "account owner", "salesperson"),
    "annual_spend": ("annual_spend", "annual spend", "ttm sales", "sales ttm", "revenue", "spend"),
    "last_order_at": ("last_order_at", "last order", "last order date", "last purchase", "last invoice date"),
}
LAPSED_AFTER = timedelta(days=365)


def _norm_header(h: str) -> str:
    return " ".join(re.sub(r"[_\-]+", " ", h.strip().lower()).split())


def _map_headers(headers: list[str]) -> dict[str, str]:
    norm = {_norm_header(h): h for h in headers}
    out: dict[str, str] = {}
    for field, aliases in HEADER_ALIASES.items():
        for a in aliases:
            if _norm_header(a) in norm:
                out[field] = norm[_norm_header(a)]
                break
    return out


def _parse_date(s: str | None) -> datetime | None:
    if not s or not s.strip():
        return None
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y-%m-%dT%H:%M:%S", "%d-%b-%Y"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _parse_money(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(re.sub(r"[^\d.\-]", "", s)) if re.search(r"\d", s) else None
    except ValueError:
        return None


def match_account(acct: dict[str, Any], cands: list[dict[str, Any]]) -> tuple[str | None, float, str | None]:
    """Best contractor for an account row -> (gaf_id, confidence, method)."""
    best: tuple[str | None, float, str | None] = (None, 0.0, None)
    a_phone, a_zip = phone_digits(acct.get("phone")), zip5(acct.get("postal_code"))
    a_city = (acct.get("city") or "").strip().lower()
    for c in cands:
        if a_phone and a_phone == phone_digits(c.get("phone")):
            sim = max(name_similarity(acct["name"], n) for n in (c.get("name"), c.get("legal_name"), c.get("dba")) if n) if acct.get("name") else 0
            conf, method = (0.97 if sim >= 0.6 else 0.9), "phone"
        else:
            sim = max((name_similarity(acct["name"], n) for n in (c.get("name"), c.get("legal_name"), c.get("dba")) if n),
                      default=0.0)
            same_zip = a_zip is not None and a_zip == zip5(c.get("postal_code"))
            same_city = bool(a_city) and a_city == (c.get("city") or "").strip().lower()
            if sim >= 0.9 and (same_zip or same_city):
                conf, method = 0.85, "name+locality"
            elif sim >= 0.97:
                conf, method = 0.6, "name"
            else:
                continue
        if conf > best[1]:
            best = (c["gaf_id"], conf, method)
    return best


def import_accounts(repo: Repository, path: str | Path, replace: bool = True) -> dict[str, Any]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        hmap = _map_headers(reader.fieldnames or [])
        if "name" not in hmap:
            raise ValueError(f"CSV needs an account-name column; got headers {reader.fieldnames}")
        raw_rows = list(reader)
    with repo.engine.connect() as conn:
        cands = [dict(r._mapping) for r in conn.execute(
            select(contractors.c.gaf_id, contractors.c.name, contractors.c.legal_name, contractors.c.dba,
                   contractors.c.phone, contractors.c.postal_code, contractors.c.city)
        )]
    now = utcnow()
    rows, matched = [], 0
    for i, r in enumerate(raw_rows):
        get = lambda k: (r.get(hmap[k]) or "").strip() if k in hmap else ""  # noqa: E731
        acct = {
            "account_id": get("account_id") or f"row-{i + 1}",
            "name": get("name"),
            "phone": get("phone") or None,
            "postal_code": get("postal_code") or None,
            "city": get("city") or None,
            "state": get("state") or None,
            "status": (get("status") or "active").lower(),
            "owner_rep": get("owner_rep") or None,
            "annual_spend": _parse_money(get("annual_spend")),
            "last_order_at": _parse_date(get("last_order_at")),
            "extra": {k: v for k, v in r.items() if k not in hmap.values()},
            "imported_at": now,
        }
        if not acct["name"]:
            continue
        gid, conf, method = match_account(acct, cands)
        acct.update(gaf_id=gid, match_confidence=conf or None, match_method=method)
        matched += gid is not None
        rows.append(acct)
    with repo.engine.begin() as conn:
        if replace:
            conn.execute(delete(accounts))
        if rows:
            conn.execute(accounts.insert(), rows)
    return {"rows": len(rows), "matched": matched, "unmatched": len(rows) - matched, "headers_mapped": hmap}


def account_status(acct: dict[str, Any] | None, now: datetime | None = None) -> str:
    """existing_customer | lapsed_customer | do_not_contact | prospect."""
    if not acct:
        return "prospect"
    status = (acct.get("status") or "").lower()
    if status in {"do_not_contact", "dnc", "do not contact"}:
        return "do_not_contact"
    last = as_utc(acct.get("last_order_at"))
    now = now or utcnow()
    if status in {"inactive", "closed", "lapsed"} or (last is not None and now - last > LAPSED_AFTER):
        return "lapsed_customer"
    if status in {"prospect", "lead"}:
        return "prospect"
    return "existing_customer"


def accounts_by_gaf_id(repo: Repository) -> dict[str, dict[str, Any]]:
    with repo.engine.connect() as conn:
        out: dict[str, dict[str, Any]] = {}
        for r in conn.execute(select(accounts).where(accounts.c.gaf_id.is_not(None))):
            d = dict(r._mapping)
            prev = out.get(d["gaf_id"])
            if prev is None or (d.get("match_confidence") or 0) > (prev.get("match_confidence") or 0):
                out[d["gaf_id"]] = d
        return out


def account_tags(acct: dict[str, Any] | None) -> list[dict[str, Any]]:
    status = account_status(acct)
    labels = {
        "existing_customer": "Existing customer",
        "lapsed_customer": "Lapsed customer — win back",
        "do_not_contact": "Do not contact",
        "prospect": "Net-new prospect",
    }
    if acct:
        reason = (f"matched CRM account {acct['account_id']} ({acct['name']}) by {acct.get('match_method')}"
                  f" @ {acct.get('match_confidence')}")
    else:
        reason = "no matching account in the imported customer list"
    tags = [{"key": "account_status", "value": status, "label": labels[status], "category": "account",
             "reason": reason, "source": "crm"}]
    if acct and acct.get("owner_rep"):
        tags.append({"key": "account_owner", "value": acct["owner_rep"], "label": f"Owner: {acct['owner_rep']}",
                     "category": "account", "reason": "owner in CRM export", "source": "crm"})
    if acct and acct.get("annual_spend") is not None:
        spend = acct["annual_spend"]
        band = "high" if spend >= 500_000 else "mid" if spend >= 100_000 else "low"
        tags.append({"key": "account_spend_band", "value": band, "label": f"Spend: {band} (${spend:,.0f}/yr)",
                     "category": "account", "reason": "annual spend in CRM export", "source": "crm"})
    return tags
