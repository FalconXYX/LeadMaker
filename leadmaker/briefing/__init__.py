"""Territory briefing (Section 4): a deterministic digest per scope plus a cached AI rewrite.

    stats = await run_briefing(settings, repo)                 # team + every rep; digest always, rewrite if possible
    digest = compute_digest(repo, "rep:<user id>", now)        # what changed in that rep's book
    text = render_digest_text(digest)                          # the deterministic brief ("" when quiet)
    digest_hash(digest)                                        # cache key of the AI rewrite (as_of excluded)

Stored in territory_briefs (one row per scope) and territory_brief_rewrites (keyed by scope, digest_hash, prompt
version and provider:model); served by the query service at GET /api/territory-brief. The worker recomputes it
after refreshes and signals runs (the 'briefing' job) and, when LEADMAKER_AI_SCHEDULES=1, hourly.
"""

from __future__ import annotations

from .digest import all_scopes, compute_digest, digest_hash
from .rewrite import BRIEFING_PROMPT_VERSION, BRIEFING_SCHEMA, BRIEFING_SYSTEM_PROMPT, validate_rewrite
from .run import run_briefing
from .text import fence, render_digest_text

__all__ = [
    "BRIEFING_PROMPT_VERSION", "BRIEFING_SCHEMA", "BRIEFING_SYSTEM_PROMPT", "all_scopes", "compute_digest",
    "digest_hash", "fence", "render_digest_text", "run_briefing", "validate_rewrite",
]
