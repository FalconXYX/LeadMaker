"""run_briefing: recompute every scope's digest, store it, and rewrite the non-quiet ones with the LLM (cached).

Digest writes always happen; the AI part is best effort. Per scope, in order:
  quiet                     -> stored with digest_text '' and no rewrite
  AI off (--no-ai / LEADMAKER_BRIEFING_AI=0)        -> rewrite_skipped.disabled
  no provider configured    -> rewrite_skipped.no_provider
  a rewrite exists for (scope, digest_hash, briefing/v1, provider:model)        -> rewrite_skipped.cached
  the scope's newest rewrite is younger than LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES (unless force)
                            -> rewrite_skipped.min_interval (the UI shows the digest text meanwhile)
  quota hit earlier in run  -> rewrite_skipped.quota (an auth error earlier: rewrite_skipped.no_provider)
  call: LlmQuotaExceeded or LlmAuthError stops rewrites for the run; another LlmError skips the scope
        (rewrite_skipped.error);
        an answer that fails validation stores an empty marker row (rewrite_skipped.invalid): the query service
        never serves it, and the same (scope, digest_hash, prompt, model) is "cached" from then on, so a digest
        the model cannot rephrase faithfully costs one call, not one per run.
"""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack
from datetime import datetime, timedelta, timezone
from typing import Any

from ..config import Settings
from ..db import Repository
from ..llm import LlmAuthError, LlmError, LlmQuotaExceeded, get_provider
from . import store
from .config import BriefingConfig
from .digest import TEAM, compute_digest, digest_hash, parse_scope, rep_scope, rep_ids
from .rewrite import BRIEFING_PROMPT_VERSION, request_rewrite
from .text import iso, render_digest_text

log = logging.getLogger(__name__)

SKIP_KEYS = ("cached", "min_interval", "invalid", "quota", "no_provider", "error", "disabled")


def resolve_scopes(repo: Repository, scopes: list[str] | str | None) -> tuple[list[str], list[str], set[str]]:
    """(scopes to compute, unknown scopes, every valid scope). None or 'all' = team + every rep. A single
    string (a job's {"scopes": "team"}) counts as one scope."""
    reps = {rep_scope(r) for r in rep_ids(repo)}
    valid = {TEAM} | reps
    if isinstance(scopes, str):
        scopes = [scopes]
    if scopes is None or any(str(s).strip().lower() == "all" for s in scopes):
        return [TEAM, *sorted(reps)], [], valid
    out: list[str] = []
    unknown: list[str] = []
    for s in scopes:
        try:
            kind, rep_id = parse_scope(str(s))
        except ValueError:
            unknown.append(str(s))
            continue
        canonical = TEAM if kind == TEAM else f"rep:{rep_id}"
        if canonical not in valid:
            unknown.append(str(s))  # not a user, or not a rep
        elif canonical not in out:
            out.append(canonical)
    return out, unknown, valid


def _provider(settings: Settings, provider: Any) -> tuple[Any, str | None]:
    """(provider or None, why not)."""
    if provider is None:
        try:
            provider = get_provider(settings)
        except ValueError as e:  # bad LEADMAKER_LLM_PROVIDER
            return None, str(e)
    if provider is None:
        return None, "no LLM provider configured"
    ok, why = provider.is_configured()
    return (provider, None) if ok else (None, why or "provider not configured")


async def run_briefing(settings: Settings, repo: Repository, *, scopes: list[str] | str | None = None,
                       rewrite: bool | None = None, force: bool = False, now: datetime | None = None,
                       provider: Any = None) -> dict[str, Any]:
    """scopes None = 'team' + 'rep:<id>' for every users.role='rep'. rewrite None = LEADMAKER_BRIEFING_AI (default on
    when a provider is configured). Returns {"scopes": n, "changed": k, "quiet": q, "rewritten": m,
    "rewrite_skipped": {"cached": a, "min_interval": b, "invalid": c, "quota": d, "no_provider": e, ...}, ...}."""
    cfg = BriefingConfig.from_env()
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    targets, unknown, valid = resolve_scopes(repo, scopes)
    want_ai = cfg.ai if rewrite is None else bool(rewrite)
    llm, why_not = _provider(settings, provider) if want_ai else (None, "disabled")
    skipped = dict.fromkeys(SKIP_KEYS, 0)
    out: dict[str, Any] = {"scopes": len(targets), "changed": 0, "quiet": 0, "rewritten": 0,
                           "rewrite_skipped": skipped, "llm_calls": 0,
                           "provider": llm.fingerprint if llm is not None else None}
    if unknown:
        out["unknown_scopes"] = unknown
    if want_ai and llm is None:
        out["no_provider_reason"] = why_not
    errors: list[dict[str, Any]] = []
    stored = store.stored_briefs(repo)
    stopped: str | None = None  # 'quota' or 'no_provider' (rejected key): no more calls this run
    min_age = timedelta(minutes=cfg.rewrite_min_minutes)

    async with AsyncExitStack() as stack:
        http = None
        for scope in targets:
            digest = compute_digest(repo, scope, now, config=cfg)
            text = render_digest_text(digest)
            h = digest_hash(digest)
            quiet = bool(digest.get("quiet"))
            if (stored.get(scope) or {}).get("digest_hash") != h:
                out["changed"] += 1
            store.upsert_brief(repo, scope=scope, digest=digest, digest_text=text, digest_hash=h, quiet=quiet,
                               poll_run_id=(digest.get("poll") or {}).get("run_id"), now=now)
            if quiet:
                out["quiet"] += 1
                continue
            if not want_ai:
                skipped["disabled"] += 1
                continue
            if llm is None:
                skipped["no_provider"] += 1
                continue
            if store.rewrite_exists(repo, scope, h, BRIEFING_PROMPT_VERSION, llm.fingerprint):
                skipped["cached"] += 1
                continue
            newest = store.newest_rewrite_at(repo, scope)
            if not force and newest is not None and now - newest < min_age:
                skipped["min_interval"] += 1
                continue
            if stopped is not None:
                skipped[stopped] += 1
                continue
            if http is None:
                from ..http import HttpClient  # local import: curl_cffi only when a call is made

                http = await stack.enter_async_context(HttpClient(settings))
            out["llm_calls"] += 1
            try:
                result = await request_rewrite(llm, http, digest, text)
            except LlmQuotaExceeded as e:
                stopped = "quota"
                skipped["quota"] += 1
                if e.resets_at is not None:
                    out["resets_at"] = iso(e.resets_at)
                log.warning("briefing: LLM quota reached; rewrites stop for this run (%s)", type(e).__name__)
                continue
            except LlmAuthError as e:  # a bad key or unknown model fails every scope alike: stop calling
                stopped = "no_provider"
                skipped["error"] += 1
                errors.append({"scope": scope, "error": type(e).__name__, "status": getattr(e, "status", None)})
                out["no_provider_reason"] = "the provider rejected the credentials or model"
                log.error("briefing: LLM auth/model error (status %s); rewrites stop for this run",
                          getattr(e, "status", None))
                continue
            except LlmError as e:  # rate limit after retries, 5xx, timeout, invalid output: skip this scope
                skipped["error"] += 1
                errors.append({"scope": scope, "error": type(e).__name__, "status": getattr(e, "status", None)})
                log.warning("briefing: rewrite for %s failed (%s, status %s)", scope, type(e).__name__,
                            getattr(e, "status", None))
                continue
            if result.text is None:
                skipped["invalid"] += 1
                errors.append({"scope": scope, "error": "invalid", "violations": result.violations[:5]})
                store.save_rewrite(repo, scope=scope, digest_hash=h, prompt_version=BRIEFING_PROMPT_VERSION,
                                   model=llm.fingerprint, text=store.REJECTED, now=now)
                continue
            store.save_rewrite(repo, scope=scope, digest_hash=h, prompt_version=BRIEFING_PROMPT_VERSION,
                               model=llm.fingerprint, text=result.text, now=now)
            out["rewritten"] += 1
    out["pruned"] = store.prune(repo, valid)
    if errors:
        out["rewrite_errors"] = errors
    return out
