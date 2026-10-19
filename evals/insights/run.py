"""Insights eval runner (batch summaries and pitches, leadmaker.insights).

    .venv/bin/python -m evals.insights.run                 # offline: fake provider (template + scripted cases)
    .venv/bin/python -m evals.insights.run --dry-run --live  # the plan and the call estimate; no provider, no calls
    .venv/bin/python -m evals.insights.run --live          # the configured provider (Gemini free tier), capped

Flags: --suite insights|all (others are the TS runner's), --live, --limit N (live default: all 11 non-scripted
cases, which batch into 2 calls), --ids a,b,
--dry-run, --out DIR (default data/evals), --batch-size K (default 5), --max-calls N (live default 3: two batched
calls plus one retry), --allow-provider NAME (live providers other than gemini/fake are refused without it).

Offline exits 1 when an asserted check fails. Live writes the report and exits 0 unless the runner itself crashes
(2 for a configuration problem such as no provider or a bad key). Reports: <out>/insights-<UTC yyyymmddThhmm>.json
and .md. Provider and model names are printed; keys never are.

--dry-run does not import leadmaker (so no settings, .env or provider credentials are loaded).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .rubric import RUBRIC, View, expect_failures, rubric, rubric_failures, view_from_raw, view_from_stored

EVALS_DIR = Path(__file__).resolve().parents[1]
REPO = EVALS_DIR.parent
SUITE_DIR = EVALS_DIR / "insights"
CASES_FILE = SUITE_DIR / "cases.jsonl"
FIXTURES = SUITE_DIR / "fixtures"
DEFAULT_OUT = REPO / "data" / "evals"
PINNED_NOW = "2026-10-19T15:00:00-04:00"
# Live: every non-scripted case (10 model leads = 2 batched calls at batch size 5); the call cap is the real limit.
LIVE_DEFAULTS = {"limit": None, "max_calls": 3}
DEFAULT_BATCH = 5
FREE_PROVIDERS = ("gemini", "fake")
SECRET = re.compile(r"AIza[0-9A-Za-z_-]{35}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}")


def scrub(s: str) -> str:
    return SECRET.sub("[redacted]", s)


# ------------------------------------------------------------------ cases

def load_cases(path: Path = CASES_FILE) -> list[dict[str, Any]]:
    out = []
    for n, line in enumerate(path.read_text().splitlines(), start=1):
        t = line.strip()
        if not t or t.startswith("//"):
            continue
        c = json.loads(t)
        c["_line"] = n
        out.append(c)
    return out


def load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text())


@dataclass
class Plan:
    mode: str
    run: list[dict[str, Any]]
    skipped: dict[str, str]  # case id -> why it is not run
    batch_size: int
    max_calls: int | None
    est_calls: int
    worst_calls: int


def select(cases: list[dict[str, Any]], *, live: bool, ids: list[str] | None, limit: int | None,
           batch_size: int, max_calls: int | None) -> Plan:
    skipped: dict[str, str] = {}
    pool = cases
    if ids:
        unknown = sorted(set(ids) - {c["id"] for c in cases})
        if unknown:
            raise SystemExit(f"unknown case ids: {', '.join(unknown)}")
        pool = [c for c in cases if c["id"] in ids]
        for c in cases:
            if c["id"] not in ids:
                skipped[c["id"]] = "not in --ids"
    if live:
        for c in pool:
            if c.get("fake_script"):
                skipped[c["id"]] = "offline only (fake_script)"
        pool = [c for c in pool if not c.get("fake_script")]
        pool = sorted(pool, key=lambda c: (not c.get("smoke"), c["_line"]))
    if limit is not None and len(pool) > limit:
        for c in pool[limit:]:
            skipped[c["id"]] = f"--limit {limit}"
        pool = pool[:limit]
    pool = sorted(pool, key=lambda c: c["_line"])
    # LLM calls: skipped-before-the-model leads cost nothing; scripted cases run on the fake (0 real calls).
    model_leads = [c for c in pool if not c.get("fake_script") and not load_fixture(c["fixture"]).get("skip_reason")]
    batches = math.ceil(len(model_leads) / batch_size) if model_leads else 0
    est = batches if live else 0
    worst = 2 * batches if live else 0  # one retry call per batch at most
    if live and max_calls is not None:
        worst = min(worst, max_calls)
    return Plan("live" if live else "offline", pool, skipped, batch_size, max_calls if live else None, est, worst)


def print_plan(p: Plan, provider: str | None = None) -> None:
    print(f"insights: {len(p.run)} cases ({p.mode}"
          + (f", provider {provider}" if provider else "")
          + f", batch size {p.batch_size}"
          + (f", budget {p.max_calls} calls" if p.max_calls is not None else "") + ")")
    print("  run: " + (", ".join(c["id"] for c in p.run) or "none"))
    for cid, why in p.skipped.items():
        print(f"  skip {cid}: {why}")
    if p.mode == "live":
        print(f"  estimated LLM calls: {p.est_calls} (worst case {p.worst_calls} with retries"
              + (f", hard cap {p.max_calls}" if p.max_calls is not None else "") + ")")
    else:
        print("  estimated LLM calls: 0 real calls (fake provider)")


# ------------------------------------------------------------------ provider plumbing

class CappedLimiter:
    """Wraps a provider's limiter: at most `cap` requests in this run (each HTTP attempt counts), then
    LlmQuotaExceeded, which generate() turns into deferred results. The wrapped limiter still spaces requests and
    counts them toward the shared day budget."""

    def __init__(self, inner: Any, cap: int):
        self.inner, self.cap, self.used = inner, cap, 0

    async def acquire(self, abort: Any = None) -> None:
        from leadmaker.llm.base import LlmQuotaExceeded

        if self.used >= self.cap:
            raise LlmQuotaExceeded(f"eval call budget of {self.cap} used", provider="eval-budget", scope="daily")
        self.used += 1
        if abort is None:
            await self.inner.acquire()
        else:
            await self.inner.acquire(abort=abort)

    def __getattr__(self, name: str) -> Any:  # backoff, mark_exhausted, resets_at, ...
        return getattr(self.inner, name)


@dataclass
class Call:
    user: str
    ms: float
    data: dict[str, Any] | None
    usage: dict[str, Any]
    error: str | None
    refs: dict[str, str] = field(default_factory=dict)  # ref -> business_name


_LEAD_RE = re.compile(r'<lead ref="([^"]+)">(.*?)</lead>', re.S)
_NAME_RE = re.compile(r"^F\d+ business_name: (.*)$", re.M)


def refs_in(user: str) -> dict[str, str]:
    return {ref: (m.group(1).strip() if (m := _NAME_RE.search(body)) else "") for ref, body in _LEAD_RE.findall(user)}


def record_calls(provider: Any) -> list[Call]:
    """Wrap provider.generate_json (instance attribute) to keep every call's prompt refs, output and latency."""
    calls: list[Call] = []
    orig = provider.generate_json

    async def generate_json(http: Any, **kw: Any) -> Any:
        t0 = time.perf_counter()
        try:
            resp = await orig(http, **kw)
        except Exception as e:  # recorded, then re-raised for generate() to classify
            calls.append(Call(kw.get("user", ""), (time.perf_counter() - t0) * 1000, None, {},
                              f"{type(e).__name__}: {scrub(str(e))[:300]}", refs_in(kw.get("user", ""))))
            raise
        calls.append(Call(kw.get("user", ""), (time.perf_counter() - t0) * 1000, resp.data, dict(resp.usage or {}),
                          None, refs_in(kw.get("user", ""))))
        return resp

    provider.generate_json = generate_json
    return calls


def fake_provider(settings: Any, script: list[Any] | None = None) -> Any:
    from leadmaker.llm import provider_class

    os.environ.setdefault("LEADMAKER_ALLOW_FAKE_LLM", "1")  # allowed() also accepts pytest
    return provider_class("fake")(settings, script=list(script or []))


# ------------------------------------------------------------------ running

def _raw_items(calls: list[Call], business_name: str) -> list[dict[str, Any]]:
    """Every raw item the model returned for this lead, in call order."""
    out = []
    for c in _calls_for(calls, business_name):
        refs = [r for r, n in c.refs.items() if n == business_name] or list(c.refs)
        if not isinstance(c.data, dict):
            continue
        for item in c.data.get("insights") or []:
            if isinstance(item, dict) and item.get("lead_ref") in refs:
                out.append(item)
                break
    return out


def _calls_for(calls: list[Call], business_name: str) -> list[Call]:
    """Calls whose prompt held this lead (by its business_name fact; single-lead calls when no name matched)."""
    named = [c for c in calls if business_name in c.refs.values()]
    return named or [c for c in calls if len(c.refs) == 1]


def evaluate_case(case: dict[str, Any], facts: Any, result: Any | None, calls: list[Call], *, live: bool,
                  skipped_reason: str | None = None) -> dict[str, Any]:
    """One case record (the same shape as evals/lib/report.ts CaseRecord)."""
    exp = case.get("expect") or {}
    scripted = bool(case.get("fake_script"))
    asserted = live or bool(case.get("offline")) or scripted
    rec: dict[str, Any] = {
        "id": case["id"], "suite": "insights", "tags": case.get("tags", []),
        "input": f"{case['fixture']} ({facts.business_name})", "asserted": asserted,
        "contractFailures": [], "failures": [], "actual": {}, "latencyMs": None,
        "llmCalls": 0, "inputTokens": 0, "outputTokens": 0,
    }
    if facts.skip_reason:
        fails = expect_failures(exp, None, facts, ok=False, attempts=0, violations=[], skipped=facts.skip_reason)
        rec.update(failures=fails, dslPass=not fails, actual={"skippedBeforeModel": facts.skip_reason})
        rec["pass"] = not fails or not asserted
        return rec
    if result is None or getattr(result, "deferred", None):
        why = skipped_reason or (f"deferred: {result.deferred}" if result is not None else "not run")
        if result is not None and result.error:
            why += f" ({scrub(result.error)[:160]})"
        rec.update(skipped=why, dslPass=None, **{"pass": False})
        return rec
    from leadmaker.insights.validate import repair_item  # lazy: --dry-run never imports leadmaker

    mine = _calls_for(calls, facts.business_name)
    # Graded as the pipeline judges them: after the model-free repairs (role-only contact -> null, focus cut to 3).
    raws = [repair_item(r) for r in _raw_items(calls, facts.business_name)]
    rec["llmCalls"] = len(mine)
    rec["latencyMs"] = round(sum(c.ms for c in mine), 1) if mine else None
    rec["inputTokens"] = int(result.usage.get("input_tokens", 0))
    rec["outputTokens"] = int(result.usage.get("output_tokens", 0))
    view: View | None = None
    if result.ok:
        # The final raw item carries fact ids per claim; fall back to the stored form.
        view = view_from_raw(raws[-1]) if raws else view_from_stored(result.insight or {})
        rec["contractFailures"] = rubric_failures(rubric(view, facts, canary=case.get("canary")))
    elif not exp.get("error"):
        rec["contractFailures"] = [f"R1: no valid insight after {result.attempts} attempts: {'; '.join(result.violations)[:400]}"]
    first = rubric(view_from_raw(raws[0]), facts, canary=case.get("canary")) if raws else None
    fails = expect_failures(exp, view, facts, ok=result.ok, attempts=result.attempts,
                            violations=list(result.violations), skipped=None)
    rec["failures"] = fails
    rec["dslPass"] = not fails
    rec["pass"] = not rec["contractFailures"] and (not fails or not asserted)
    rec["actual"] = {
        "ok": result.ok, "attempts": result.attempts, "violations": result.violations,
        **({"summary": result.insight.get("summary"), "pitch": result.insight.get("pitch"),
            "talking_points": result.insight.get("talking_points"), "target_contact": result.insight.get("target_contact"),
            "product_focus": result.insight.get("product_focus"),
            "cited_facts": [c.get("id") for c in result.insight.get("cited_facts") or []]} if result.ok and result.insight else {}),
        "first_pass_rubric": {k: v for k, v in (first or {}).items() if v} if first is not None else None,
    }
    return rec


async def run_cases(plan: Plan, *, provider: Any, settings: Any, http: Any, live: bool,
                    fake_factory: Any = None) -> tuple[list[dict[str, Any]], list[Call], list[str]]:
    """Run the planned cases; returns (case records, all recorded calls, notes)."""
    from leadmaker.insights import facts_from_dict, generate

    notes: list[str] = []
    records: dict[str, dict[str, Any]] = {}
    all_calls: list[Call] = []
    facts_by_id = {c["id"]: facts_from_dict(load_fixture(c["fixture"])) for c in plan.run}
    plain = [c for c in plan.run if not c.get("fake_script")]
    scripted = [c for c in plan.run if c.get("fake_script")]

    # Skipped before the model (do_not_contact, delisted), exactly like run_insights.
    for c in plain:
        if facts_by_id[c["id"]].skip_reason:
            records[c["id"]] = evaluate_case(c, facts_by_id[c["id"]], None, [], live=live)
    batchable = [c for c in plain if not facts_by_id[c["id"]].skip_reason]

    calls = record_calls(provider)
    stop: str | None = None
    for i in range(0, len(batchable), plan.batch_size):
        batch = batchable[i:i + plan.batch_size]
        if stop:
            for c in batch:
                records[c["id"]] = evaluate_case(c, facts_by_id[c["id"]], None, [], live=live, skipped_reason=stop)
            continue
        before = len(calls)
        results = await generate(provider, http, [facts_by_id[c["id"]] for c in batch])
        batch_calls = calls[before:]
        for c, r in zip(batch, results):
            records[c["id"]] = evaluate_case(c, facts_by_id[c["id"]], r, batch_calls, live=live)
        deferred = {r.deferred for r in results if r.deferred}
        if "auth" in deferred:
            raise RuntimeError("the provider rejected the key or model (auth); fix the configuration and rerun")
        if "quota" in deferred:
            stop = "call budget or daily quota reached"
            notes.append(f"Stopped after batch {i // plan.batch_size + 1}: {stop}.")
    all_calls += calls

    # Scripted adversarial outputs: each case alone on its own fake provider.
    for c in scripted:
        fp = (fake_factory or fake_provider)(settings, c["fake_script"])
        sc = record_calls(fp)
        results = await generate(fp, None, [facts_by_id[c["id"]]])
        records[c["id"]] = evaluate_case(c, facts_by_id[c["id"]], results[0], sc, live=live)
        all_calls += sc

    for cid, why in plan.skipped.items():
        records.setdefault(cid, {"id": cid, "suite": "insights", "tags": [], "input": "", "asserted": False,
                                 "pass": False, "dslPass": None, "contractFailures": [], "failures": [],
                                 "skipped": why, "actual": {}, "latencyMs": None, "llmCalls": 0,
                                 "inputTokens": 0, "outputTokens": 0})
    order = {c["id"]: c["_line"] for c in load_cases()}
    return sorted(records.values(), key=lambda r: order.get(r["id"], 10**6)), all_calls, notes


# ------------------------------------------------------------------ report

def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, math.ceil(p / 100 * len(s)) - 1))]


def _rate(xs: list[bool]) -> dict[str, int]:
    return {"pass": sum(1 for x in xs if x), "total": len(xs)}


def summarize(cases: list[dict[str, Any]], calls: list[Call]) -> dict[str, Any]:
    run = [c for c in cases if not c.get("skipped")]
    tags = sorted({t for c in run for t in c["tags"]})
    lat = [c["latencyMs"] for c in run if isinstance(c.get("latencyMs"), (int, float))]
    graded = [c for c in run if c.get("actual", {}).get("ok")]
    per_rule = {r: _rate([not any(f.startswith(f"{r}:") for f in c["contractFailures"]) for c in graded]) for r in RUBRIC}
    first = [c for c in graded if c["actual"].get("first_pass_rubric") is not None]
    return {
        "cases": len(cases), "run": len(run), "skipped": len(cases) - len(run),
        "passRate": _rate([c["pass"] for c in run]),
        "asserted": _rate([c["pass"] for c in run if c["asserted"]]),
        "dsl": _rate([c["dslPass"] is True for c in run if c.get("dslPass") is not None]),
        "contract": _rate([not c["contractFailures"] for c in run]),
        "rubric": per_rule,
        "firstPassRubric": _rate([not c["actual"]["first_pass_rubric"] for c in first]),
        "byTag": {t: {"pass": _rate([c["pass"] for c in run if t in c["tags"]]),
                      "dsl": _rate([c["dslPass"] is True for c in run if t in c["tags"] and c.get("dslPass") is not None])}
                  for t in tags},
        "latencyMs": {"p50": percentile(lat, 50), "p95": percentile(lat, 95)},
        "llmCalls": len(calls),
        "callLatencyMs": {"p50": percentile([c.ms for c in calls], 50), "p95": percentile([c.ms for c in calls], 95)},
        "inputTokens": sum(int(c.usage.get("input_tokens", 0)) for c in calls),
        "outputTokens": sum(int(c.usage.get("output_tokens", 0)) for c in calls),
    }


def _pct(r: dict[str, int]) -> str:
    return f"{r['pass']}/{r['total']} ({round(100 * r['pass'] / r['total'])}%)" if r["total"] else "n/a"


def _ms(v: float | None) -> str:
    return "n/a" if v is None else f"{round(v)} ms"


def _cell(v: Any, n: int = 160) -> str:
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    s = re.sub(r"\s+", " ", s).replace("|", "\\|")
    return s if len(s) <= n else s[: n - 1] + "…"


def render_markdown(r: dict[str, Any]) -> str:
    s = r["summary"]
    lines = [
        "# Eval report: insights", "",
        f"Mode **{r['mode']}** · provider {r['provider'] or 'none'} · model {r['model'] or 'n/a'} · prompt {r['promptVersion']}",
        f"Started {r['startedAt']} · finished {r['finishedAt']} · batch size {r['options'].get('batchSize')}", "",
        "| Metric | Value |", "|---|---|",
        f"| Cases run / skipped | {s['run']} / {s['skipped']} |",
        f"| Pass rate (rubric + expectations) | {_pct(s['passRate'])} |",
        f"| Asserted cases | {_pct(s['asserted'])} |",
        f"| Per-case expectations | {_pct(s['dsl'])} |",
        f"| Rubric R1-R13 (final results) | {_pct(s['contract'])} |",
        f"| Rubric on the first attempt | {_pct(s['firstPassRubric'])} |",
        f"| Latency per case p50 / p95 | {_ms(s['latencyMs']['p50'])} / {_ms(s['latencyMs']['p95'])} |",
        f"| {'Fake provider calls' if r['mode'] == 'offline' else 'LLM calls'} · input tokens · output tokens | "
        f"{s['llmCalls']} · {s['inputTokens']} · {s['outputTokens']} |", "",
    ]
    lines += [f"- {scrub(n)}" for n in r["notes"]]
    if r["notes"]:
        lines.append("")
    lines += ["## Rubric", "", "| Rule | Pass |", "|---|---|"]
    lines += [f"| {k} | {_pct(v)} |" for k, v in s["rubric"].items()]
    lines.append("")
    if s["byTag"]:
        lines += ["## By tag", "", "| Tag | Pass | Expectations |", "|---|---|---|"]
        lines += [f"| {t} | {_pct(v['pass'])} | {_pct(v['dsl'])} |" for t, v in s["byTag"].items()]
        lines.append("")
    failed = [c for c in r["cases"] if not c.get("skipped") and (not c["pass"] or c.get("dslPass") is False)]
    lines += ["## Failures", ""]
    if not failed:
        lines += ["None.", ""]
    else:
        lines += ["| Case | Asserted | Input | Failed checks | Actual |", "|---|---|---|---|---|"]
        for c in failed:
            why = "; ".join([*c["contractFailures"], *c["failures"]])
            act = {k: c["actual"].get(k) for k in ("summary", "pitch", "violations") if c["actual"].get(k)}
            lines.append(f"| {c['id']} | {'yes' if c['asserted'] else 'no'} | {_cell(c['input'], 80)} | "
                         f"{_cell(scrub(why), 300)} | {_cell(scrub(json.dumps(act, ensure_ascii=False)), 200)} |")
        lines.append("")
    skipped: dict[str, list[str]] = {}
    for c in r["cases"]:
        if c.get("skipped"):
            skipped.setdefault(c["skipped"], []).append(c["id"])
    if skipped:
        lines += ["## Skipped", "", "| Why | Cases |", "|---|---|"]
        lines += [f"| {_cell(scrub(why))} | {', '.join(ids)} |" for why, ids in skipped.items()]
        lines.append("")
    return "\n".join(lines) + "\n"


def stamp(d: datetime) -> str:
    return d.astimezone(timezone.utc).strftime("%Y%m%dT%H%M")


def write_report(report: dict[str, Any], out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    base = out_dir / f"insights-{stamp(datetime.fromisoformat(report['finishedAt']))}"
    jp, mp = base.with_suffix(".json"), base.with_suffix(".md")
    jp.write_text(scrub(json.dumps(report, indent=2, ensure_ascii=False, default=str)) + "\n")
    mp.write_text(render_markdown(report))
    return jp, mp


def build_report(*, mode: str, provider: Any, plan: Plan, cases: list[dict[str, Any]], calls: list[Call],
                 notes: list[str], started: datetime, options: dict[str, Any]) -> dict[str, Any]:
    from leadmaker.insights import PROMPT_VERSION

    return {
        "suite": "insights", "mode": mode,
        "provider": getattr(provider, "name", None), "model": getattr(provider, "model", None),
        "promptVersion": PROMPT_VERSION,
        "startedAt": started.isoformat(), "finishedAt": datetime.now(timezone.utc).isoformat(),
        "now": PINNED_NOW, "options": options, "cases": cases, "notes": notes,
        "calls": [{"ms": round(c.ms, 1), "refs": list(c.refs), "usage": c.usage, "error": c.error} for c in calls],
        "summary": summarize(cases, calls),
    }


# ------------------------------------------------------------------ CLI

def parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m evals.insights.run", description=__doc__.split("\n\n")[0])
    p.add_argument("--suite", default="insights", choices=("insights", "all", "nl_filter", "lead_qa"))
    p.add_argument("--live", action="store_true")
    p.add_argument("--limit", type=int)
    p.add_argument("--ids")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--batch-size", type=int, default=DEFAULT_BATCH)
    p.add_argument("--max-calls", type=int)
    p.add_argument("--allow-provider", action="append", default=[])
    return p.parse_args(argv)


async def _amain(a: argparse.Namespace) -> int:
    live = a.live
    ids = [x.strip() for x in a.ids.split(",")] if a.ids else None
    limit = a.limit if a.limit is not None else (LIVE_DEFAULTS["limit"] if live else None)
    max_calls = a.max_calls if a.max_calls is not None else (LIVE_DEFAULTS["max_calls"] if live else None)
    batch = max(1, min(8, a.batch_size))
    plan = select(load_cases(), live=live, ids=ids, limit=limit, batch_size=batch, max_calls=max_calls)
    if a.dry_run:
        print_plan(plan)
        print("dry run: no provider was created and no calls were made")
        return 0

    from leadmaker.config import get_settings
    from leadmaker.llm import LlmAuthError, get_provider

    settings = get_settings()
    if live:
        name = settings.llm_provider
        if name is None:
            print("no LLM provider is configured (set GEMINI_API_KEY in .env, or LEADMAKER_LLM_PROVIDER)", file=sys.stderr)
            return 2
        if name not in FREE_PROVIDERS and name not in a.allow_provider:
            print(f"refusing live provider {name!r}: only the Gemini free tier is approved for live evals "
                  f"(pass --allow-provider {name} to override)", file=sys.stderr)
            return 2
        provider = get_provider(settings)
        ok, why = provider.is_configured()
        if not ok:
            print(f"provider {name} is not configured: {why}", file=sys.stderr)
            return 2
        if max_calls is not None:
            provider.limiter = CappedLimiter(provider.limiter, max_calls)
    else:
        provider = fake_provider(settings)
    print_plan(plan, provider.fingerprint)
    started = datetime.now(timezone.utc)
    try:
        if live and provider.name != "fake":
            from leadmaker.http import HttpClient

            async with HttpClient(settings) as http:
                cases, calls, notes = await run_cases(plan, provider=provider, settings=settings, http=http, live=True)
        else:
            cases, calls, notes = await run_cases(plan, provider=provider, settings=settings, http=None, live=live)
    except (LlmAuthError, RuntimeError) as e:
        print(f"aborted: {scrub(str(e))[:300]}", file=sys.stderr)
        return 2
    report = build_report(mode=plan.mode, provider=provider, plan=plan, cases=cases, calls=calls, notes=notes,
                          started=started, options={"limit": limit, "ids": ids, "batchSize": batch, "maxCalls": max_calls})
    jp, mp = write_report(report, a.out)
    s = report["summary"]
    print(f"insights ({plan.mode}): pass {_pct(s['passRate'])}, asserted {_pct(s['asserted'])}, "
          f"rubric {_pct(s['contract'])}, {s['llmCalls']} {'fake provider' if plan.mode == 'offline' else 'LLM'} calls")
    print(f"report: {mp}\n        {jp}")
    if not live and s["asserted"]["pass"] < s["asserted"]["total"]:
        for c in cases:
            if c["asserted"] and not c["pass"] and not c.get("skipped"):
                print(f"  FAIL {c['id']}: {'; '.join([*c['contractFailures'], *c['failures']])[:300]}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    a = parse_args(argv)
    if a.suite not in ("insights", "all"):
        print(f"nothing to do for --suite {a.suite}: the TS runner (evals/assistant/run.ts) covers it")
        return 0
    return asyncio.run(_amain(a))


if __name__ == "__main__":
    sys.exit(main())
