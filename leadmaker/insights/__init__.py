"""Section 4 batch insights: a short summary, a one-sentence pitch, talking points and the person to ask for, per
lead, written by the configured LLM from every fact we hold (GAF attributes, website text, size, tags, rep notes,
custom fields and tags) and regenerated only when `input_hash` (facts + prompt version + model + schema) changes.
Weather timing is a separate rules-based layer and never triggers a rerun.

    from leadmaker.insights import InsightsOptions, run_insights
    await run_insights(settings, repo, InsightsOptions(stale=True))

Modules: facts (facts, fencing, input_hash), prompt (insights/v1), validate (guards), generate (batch call, one
retry with feedback), store (rows, pruning, outbox), run (lead selection and the run), cli.
"""

from __future__ import annotations

from .facts import Fact, LeadFacts, build_facts, facts_from_dict, fence, input_hash
from .generate import InsightResult, generate
from .prompt import OUTPUT_SCHEMA, PRODUCT_LINES, PROMPT_VERSION, SYSTEM_PROMPT, render_leads_block
from .run import InsightsOptions, candidates, run_insights
from .store import save_results
from .validate import validate_item

__all__ = [
    "OUTPUT_SCHEMA", "PRODUCT_LINES", "PROMPT_VERSION", "SYSTEM_PROMPT", "Fact", "InsightResult", "InsightsOptions",
    "LeadFacts", "build_facts", "candidates", "facts_from_dict", "fence", "generate", "input_hash",
    "render_leads_block", "run_insights", "save_results", "validate_item",
]
