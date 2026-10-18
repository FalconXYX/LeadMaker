"""User-defined tag rules (Section 1: "users can pass custom parameters to guide what tags are generated").

Sales ops can add tags without code changes, via a JSON file passed to
`leadmaker tag --rules rules.json` (or $LEADMAKER_TAG_RULES). Example:

    [
      {"key": "slate_specialist", "label": "Slate specialist", "priority_boost": 5,
       "when": {"text_contains": ["slate"]}},
      {"key": "high_volume", "label": "200+ reviews",
       "when": {"field": "review_count", "gte": 200}},
      {"key": "queens", "label": "Queens",
       "when": {"field": "city", "in": ["Flushing", "Jamaica", "Astoria", "Long Island City"]}},
      {"key": "nj_master_elite", "label": "NJ Master Elite",
       "when": {"all": [{"field": "state", "eq": "NJ"}, {"field": "tier", "eq": "master_elite"}]}}
    ]

Conditions: {"field", op} with op in eq | ne | in | gte | lte | exists | contains;
{"text_contains": [...]} searches every text we hold about the lead (GAF
description/certifications/reviews, website pages/services, LLM summary);
{"all": [...]}, {"any": [...]}, {"not": {...}} compose. `priority_boost`
(±) is added to the priority score (clamped to 0..100).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

OPS = ("eq", "ne", "in", "gte", "lte", "exists", "contains")


class RuleError(ValueError):
    pass


def load_rules(path: str | Path | None = None) -> list[dict[str, Any]]:
    path = path or os.environ.get("LEADMAKER_TAG_RULES")
    if not path:
        return []
    rules = json.loads(Path(path).read_text())
    if not isinstance(rules, list):
        raise RuleError("rules file must contain a JSON list")
    for r in rules:
        if not isinstance(r, dict) or "key" not in r or "when" not in r:
            raise RuleError(f"each rule needs 'key' and 'when': {r!r}")
        _validate(r["when"])
    return rules


def _validate(cond: Any) -> None:
    if not isinstance(cond, dict):
        raise RuleError(f"condition must be an object: {cond!r}")
    if "all" in cond or "any" in cond:
        for c in cond.get("all", cond.get("any")):
            _validate(c)
    elif "not" in cond:
        _validate(cond["not"])
    elif "text_contains" in cond:
        if not isinstance(cond["text_contains"], list):
            raise RuleError("text_contains takes a list of strings")
    elif "field" in cond:
        if not any(op in cond for op in OPS):
            raise RuleError(f"field condition needs one of {OPS}: {cond!r}")
    else:
        raise RuleError(f"unknown condition: {cond!r}")


def lead_text(lead: dict[str, Any]) -> str:
    """All free text we hold about a lead, lower-cased, for keyword rules."""
    parts: list[str] = []
    for k in ("name", "legal_name", "dba", "description"):
        if lead.get(k):
            parts.append(str(lead[k]))
    parts += [str(x) for x in (lead.get("certifications") or []) + (lead.get("specialties") or [])]
    parts += [r.get("text") or "" for r in lead.get("reviews") or []]
    for src, row in (lead.get("enrichment") or {}).items():
        data = (row or {}).get("data") or {}
        for p in data.get("pages") or []:
            parts.append(p.get("text") or "")
        for k in ("services", "service_areas"):
            parts += [str(x) for x in data.get(k) or []]
        if data.get("summary"):
            parts.append(str(data["summary"]))
    return "\n".join(parts).lower()


def _field(lead: dict[str, Any], name: str) -> Any:
    cur: Any = lead
    for part in name.split("."):  # dotted paths reach into enrichment, e.g. enrichment.nyc_dcwp.status
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def evaluate(cond: dict[str, Any], lead: dict[str, Any], text: str | None = None) -> bool:
    if "all" in cond:
        return all(evaluate(c, lead, text) for c in cond["all"])
    if "any" in cond:
        return any(evaluate(c, lead, text) for c in cond["any"])
    if "not" in cond:
        return not evaluate(cond["not"], lead, text)
    if "text_contains" in cond:
        t = text if text is not None else lead_text(lead)
        return any(str(k).lower() in t for k in cond["text_contains"])
    v = _field(lead, cond["field"])
    if "exists" in cond:
        return (v not in (None, "", [], {})) == bool(cond["exists"])
    if v is None:
        return False
    try:
        if "eq" in cond:
            return v == cond["eq"]
        if "ne" in cond:
            return v != cond["ne"]
        if "in" in cond:
            return v in cond["in"]
        if "gte" in cond:
            return v >= cond["gte"]
        if "lte" in cond:
            return v <= cond["lte"]
        if "contains" in cond:
            return str(cond["contains"]).lower() in (
                " ".join(map(str, v)) if isinstance(v, list) else str(v)
            ).lower()
    except TypeError:
        return False
    return False


def apply_rules(lead: dict[str, Any], rules: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], float]:
    """Returns (custom tags, total priority boost)."""
    if not rules:
        return [], 0.0
    text = lead_text(lead)
    tags, boost = [], 0.0
    for r in rules:
        if evaluate(r["when"], lead, text):
            tags.append({
                "key": r["key"], "value": r.get("value", True), "label": r.get("label", r["key"]),
                "category": r.get("category", "custom"), "reason": r.get("reason", "matched custom rule"),
                "source": "custom_rule",
            })
            boost += float(r.get("priority_boost", 0))
    return tags, boost
