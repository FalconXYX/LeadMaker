"""One batch of leads -> validated insights: `await generate(provider, http, leads)`.

    attempt 1: one call for the whole batch (K leads, refs L1..LK)
      -> items missing for some refs, or items with violations?
    attempt 2: ONE retry for just those leads (same refs), with the violations appended as feedback
      -> still failing: InsightResult(ok=False, violations, attempts=2), stored as a status='error' row

A whole-call LlmOutputError (invalid JSON, truncation, safety block) on a batch of several leads retries each
lead alone once; on a single lead it retries once. Provider errors never raise out of here: the leads they hit
come back as `deferred` results ("quota", "auth", "rate_limited", "api") that get no row, so whatever the batch
already decided is still saved; run_insights stops on quota and aborts on auth.

Request building (SYSTEM_PROMPT + render_leads_block) is kept apart from parsing (`results_from_payload`), so a
provider batch API (Anthropic Message Batches, 50% price) can reuse both later.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from ..llm.base import (
    LlmApiError, LlmAuthError, LlmError, LlmOutputError, LlmProvider, LlmQuotaExceeded, LlmRateLimited, LlmResponse,
)
from .facts import LeadFacts, input_hash
from .prompt import MAX_OUTPUT_TOKENS, OUTPUT_SCHEMA, SCHEMA_NAME, SYSTEM_PROMPT, lead_refs, render_leads_block
from .validate import clean_item, cross_lead_problems, repair_item, validate_item

log = logging.getLogger(__name__)

@dataclass
class InsightResult:
    company_id: str
    ok: bool
    insight: dict | None  # {"summary","pitch","talking_points","target_contact","product_focus","cited_facts"}
    violations: list[str]
    attempts: int  # model calls this lead took in this run: 1 or 2
    usage: dict
    input_hash: str = ""
    model: str = ""  # provider fingerprint, e.g. "gemini:gemini-3.8-flash"
    # Set when a provider error left the lead undecided ("quota" | "auth" | "rate_limited" | "api"): no row is
    # written and the next run picks it up.
    deferred: str | None = None
    error: str | None = None  # the provider error behind `deferred` (no secrets: providers never echo keys)
    resets_at: str | None = None  # deferred == "quota": when the daily quota resets (ISO, UTC), if known


@dataclass
class _Lead:
    ref: str
    facts: LeadFacts
    attempts: int = 0
    usage: dict[str, int] = field(default_factory=lambda: {"input_tokens": 0, "output_tokens": 0})
    batch_size: int = 1


def feedback(problems: dict[str, list[str]]) -> str:
    lines = [f"- {ref}: {p}" for ref, ps in problems.items() for p in ps]
    return ("Your previous answer had problems:\n" + "\n".join(lines)
            + "\nReturn corrected JSON for these leads only.")


def norm_ref(ref: Any) -> str:
    """'L2', 'l2', ' L2 ', '2' -> 'L2'."""
    s = str(ref or "").strip().strip('"').upper()
    return f"L{s}" if s.isdigit() else s


def items_by_ref(payload: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    items = (payload or {}).get("insights") if isinstance(payload, dict) else None
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict):
            out.setdefault(norm_ref(item.get("lead_ref")), item)  # first item per ref wins
    return out


def _safe(e: BaseException) -> str:
    from .store import redact  # lazy: store imports this module

    return redact(str(e))[:500]


def _deferral(e: LlmError) -> str:
    if isinstance(e, LlmQuotaExceeded):
        return "quota"
    if isinstance(e, LlmAuthError):
        return "auth"
    if isinstance(e, LlmRateLimited):
        return "rate_limited"
    return "api"


async def _call(provider: LlmProvider, http, leads: Sequence[_Lead], extra: str = "",
                stats: dict[str, int] | None = None) -> LlmResponse:
    user = render_leads_block([x.facts for x in leads], [x.ref for x in leads])
    if extra:
        user += "\n\n" + extra
    for x in leads:
        x.attempts += 1
    if stats is not None:
        stats["llm_calls"] = stats.get("llm_calls", 0) + 1
    resp = await provider.generate_json(http, system=SYSTEM_PROMPT, user=user, schema=OUTPUT_SCHEMA,
                                        schema_name=SCHEMA_NAME, max_output_tokens=MAX_OUTPUT_TOKENS)
    k = max(1, len(leads))
    for x in leads:  # a batch call's usage, split evenly
        x.usage["input_tokens"] += int(resp.usage.get("input_tokens", 0)) // k
        x.usage["output_tokens"] += int(resp.usage.get("output_tokens", 0)) // k
        x.batch_size = len(leads)
    return resp


def _judge(leads: Sequence[_Lead], payload: dict[str, Any] | None) -> tuple[dict[str, dict], dict[str, list[str]]]:
    """(valid items by ref, violations by ref) for these leads. Items are repaired first (repair_item), then
    checked against their own lead's facts and, for cross-lead copying, against the other leads in the call."""
    items = items_by_ref(payload)
    good: dict[str, dict] = {}
    bad: dict[str, list[str]] = {}
    for x in leads:
        item = items.get(x.ref)
        if item is None:
            bad[x.ref] = ["no item was returned for this lead"]
            continue
        item = repair_item(item)
        problems = validate_item(item, x.facts) or cross_lead_problems(item, x.facts,
                                                                        [o.facts for o in leads if o is not x])
        if problems:
            bad[x.ref] = problems
            # Only the final attempt's problems reach the error row; log every attempt's so a failed Refresh is
            # explainable even when the retry never ran.
            log.info("insights %s: answer rejected: %s", x.facts.company_id, "; ".join(problems)[:500])
        else:
            good[x.ref] = item
    return good, bad


async def generate(provider: LlmProvider, http, leads: Sequence[LeadFacts], *,
                   stats: dict[str, int] | None = None) -> list[InsightResult]:
    """Insights for one batch; one InsightResult per lead, in input order. A lead with a skip_reason
    (do_not_contact, delisted) is never sent: its result is `deferred=<skip_reason>` with 0 attempts (no row)."""
    fp = provider.fingerprint
    live = [f for f in leads if not f.skip_reason]
    got = iter(await _generate(provider, http, live, stats=stats) if live else [])
    return [
        InsightResult(company_id=f.company_id, ok=False, insight=None, violations=[], attempts=0, usage={},
                      input_hash=input_hash(f, fp), model=fp, deferred=f.skip_reason)
        if f.skip_reason else next(got)
        for f in leads
    ]


async def _generate(provider: LlmProvider, http, leads: Sequence[LeadFacts], *,
                    stats: dict[str, int] | None = None) -> list[InsightResult]:
    if not leads:
        return []
    fp = provider.fingerprint
    work = [_Lead(ref, f) for ref, f in zip(lead_refs(len(leads)), leads)]
    by_ref = {x.ref: x for x in work}
    done: dict[str, InsightResult] = {}

    def result(x: _Lead, *, item: dict | None = None, violations: list[str] | None = None,
               deferred: str | None = None, error: str | None = None,
               resets_at: str | None = None) -> InsightResult:
        return InsightResult(
            company_id=x.facts.company_id, ok=item is not None, insight=clean_item(item, x.facts) if item else None,
            violations=list(violations or []), attempts=x.attempts,
            usage={**x.usage, "batch_size": x.batch_size}, input_hash=input_hash(x.facts, fp), model=fp,
            deferred=deferred, error=error, resets_at=resets_at,
        )

    def defer_rest(e: LlmError) -> None:
        resets = getattr(e, "resets_at", None)
        for x in work:
            if x.ref not in done:
                done[x.ref] = result(x, deferred=_deferral(e), error=_safe(e),
                                     resets_at=resets.isoformat() if hasattr(resets, "isoformat") else None)

    # attempt 1: the whole batch
    retry: dict[str, list[str]] = {}
    try:
        resp = await _call(provider, http, work, stats=stats)
    except LlmOutputError as e:
        retry = {x.ref: [f"the previous answer was unusable ({e})"] for x in work}
        payload = None
        solo = len(work) > 1
    except (LlmQuotaExceeded, LlmAuthError, LlmRateLimited, LlmApiError, LlmError) as e:
        defer_rest(e)
        return [done[x.ref] for x in work]
    else:
        payload, solo = resp.data, False
        good, retry = _judge(work, payload)
        for ref, item in good.items():
            done[ref] = result(by_ref[ref], item=item)

    # attempt 2: one retry for what failed (alone after a whole-batch output failure, else together)
    groups = [[by_ref[r]] for r in retry] if solo else ([[by_ref[r] for r in retry]] if retry else [])
    for group in groups:
        if all(x.ref in done for x in group):
            continue
        problems = {x.ref: retry[x.ref] for x in group}
        try:
            resp = await _call(provider, http, group, extra=feedback(problems) if payload is not None else "",
                               stats=stats)
        except LlmOutputError as e:
            for x in group:
                done[x.ref] = result(x, violations=[*problems[x.ref], f"retry was unusable too ({e})"])
            continue
        except (LlmQuotaExceeded, LlmAuthError) as e:
            defer_rest(e)
            break
        except (LlmRateLimited, LlmApiError, LlmError) as e:
            for x in group:
                done[x.ref] = result(x, deferred=_deferral(e), error=_safe(e))
            continue
        good, bad = _judge(group, resp.data)
        for ref, item in good.items():
            done[ref] = result(by_ref[ref], item=item)
        for ref, problems_now in bad.items():
            done[ref] = result(by_ref[ref], violations=problems_now)
    return [done[x.ref] for x in work]


__all__ = ["InsightResult", "feedback", "generate", "items_by_ref", "norm_ref"]
