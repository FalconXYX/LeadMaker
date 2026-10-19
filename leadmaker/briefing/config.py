"""Briefing settings, read from the environment directly (leadmaker/config.py stays untouched).

  LEADMAKER_BRIEFING_AI                   1   rewrite the digest with the LLM when a provider is configured
  LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES  60  per-scope minimum minutes between rewrites (--force overrides)
  LEADMAKER_BRIEFING_POLL_WINDOW_DAYS     7   a GAF poll older than this is not "news"
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass

log = logging.getLogger(__name__)

DEFAULT_REWRITE_MIN_MINUTES = 60.0
DEFAULT_POLL_WINDOW_DAYS = 7.0


def _flag(raw: str | None, default: bool) -> bool:
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


def _number(raw: str | None, default: float, name: str) -> float:
    """A non-negative number, or the default (with a warning) when the value is unusable: a typo in the env
    must not stop the deterministic digest from being written."""
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        value = -1.0
    if value < 0 or value != value:  # negative or NaN
        log.warning("%s=%r is not a non-negative number; using %s", name, raw, default)
        return default
    return value


@dataclass(frozen=True)
class BriefingConfig:
    ai: bool = True
    rewrite_min_minutes: float = DEFAULT_REWRITE_MIN_MINUTES
    poll_window_days: float = DEFAULT_POLL_WINDOW_DAYS

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "BriefingConfig":
        env = os.environ if env is None else env
        return cls(
            ai=_flag(env.get("LEADMAKER_BRIEFING_AI"), True),
            rewrite_min_minutes=_number(env.get("LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES"), DEFAULT_REWRITE_MIN_MINUTES,
                                        "LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES"),
            poll_window_days=_number(env.get("LEADMAKER_BRIEFING_POLL_WINDOW_DAYS"), DEFAULT_POLL_WINDOW_DAYS,
                                     "LEADMAKER_BRIEFING_POLL_WINDOW_DAYS"),
        )
