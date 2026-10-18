"""Recompute tags/segment/priority for every lead (pure function over stored facts).

Layers, in order:
  1. leadmaker.tagging.tag_lead  -- built-in structured + derived tags, segment, priority
  2. CRM account status          -- existing / lapsed / do-not-contact / prospect (leadmaker.accounts)
  3. user-defined rules          -- JSON rules file (leadmaker.custom_tags), may boost priority
Later layers win on tag-key collisions. Every change is written to the audit log.
"""

from __future__ import annotations

import logging
from collections import Counter
from pathlib import Path
from typing import Any

from ..accounts import account_status, account_tags, accounts_by_gaf_id
from ..custom_tags import apply_rules, load_rules
from ..db import Repository
from ..tagging import tag_lead

log = logging.getLogger(__name__)


def _merge(base: list[dict[str, Any]], extra: list[dict[str, Any]]) -> list[dict[str, Any]]:
    keys = {t.get("key") for t in extra}
    return [t for t in base if t.get("key") not in keys] + extra


def run_tagging(
    repo: Repository,
    postal_code: str | None = "10013",
    radius_miles: float | None = 25,
    rules_path: str | Path | None = None,
) -> dict[str, Any]:
    rules = load_rules(rules_path)
    run_id = repo.start_run(
        "tag", {"postal_code": postal_code, "radius_miles": radius_miles, "custom_rules": len(rules)}
    )
    leads = repo.lead_records(postal_code, radius_miles)
    accts = accounts_by_gaf_id(repo)
    segments: Counter = Counter()
    statuses: Counter = Counter()
    custom_hits = 0
    failed = 0
    for lead in leads:
        try:
            acct = accts.get(lead["gaf_id"])
            lead["account"] = acct
            out = tag_lead(lead)
            tags = _merge(out["tags"], account_tags(acct))
            custom, boost = apply_rules(lead, rules)
            custom_hits += bool(custom)
            tags = _merge(tags, custom)
            priority = out.get("priority_score")
            if priority is not None:
                priority = max(0.0, min(100.0, float(priority) + boost))
            status = account_status(acct)
            if status == "do_not_contact":
                priority = 0.0
        except Exception as e:  # a bad record must not block the rest
            failed += 1
            log.warning("tagging failed for %s: %s", lead.get("gaf_id"), e)
            continue
        repo.save_tags(lead["gaf_id"], tags, out.get("segment"), priority, run_id=run_id)
        segments[out.get("segment")] += 1
        statuses[status] += 1
    stats = {
        "run_id": run_id,
        "tagged": len(leads) - failed,
        "failed": failed,
        "segments": dict(segments),
        "account_status": dict(statuses),
        "custom_rules": len(rules),
        "leads_matching_custom_rules": custom_hits,
    }
    repo.finish_run(run_id, "partial" if failed else "succeeded", stats)
    return stats
