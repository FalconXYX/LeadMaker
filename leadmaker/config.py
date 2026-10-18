"""Runtime settings, read from environment variables (12-factor style).

Everything has a sensible default so `leadmaker scrape` works out of the box;
production deployments override via env (DATABASE_URL, API keys, rate limits).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw else default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else default


def _env_opt_int(name: str) -> int | None:
    raw = os.environ.get(name)
    return int(raw) if raw else None


# LLM providers (leadmaker.llm). Model ids verified on the vendors' model pages, Oct 2026:
# gemini-3.8-flash is the newest stable Flash model with a free tier (demo); claude-haiku-5-5 is the
# production batch model. openai_compat (e.g. a local Ollama) has no sensible default: set LEADMAKER_LLM_MODEL.
LLM_PROVIDERS = ("gemini", "anthropic", "openai_compat")
DEFAULT_LLM_MODELS = {"gemini": "gemini-3.8-flash", "anthropic": "claude-haiku-5-5", "openai_compat": ""}


@dataclass(frozen=True)
class Settings:
    database_url: str = field(
        default_factory=lambda: os.environ.get("DATABASE_URL", "sqlite:///data/leadmaker.db")
    )

    # Optional API keys -- enrichers that need them are skipped when absent.
    google_maps_api_key: str | None = field(
        default_factory=lambda: os.environ.get("GOOGLE_MAPS_API_KEY") or None
    )
    anthropic_api_key: str | None = field(
        default_factory=lambda: os.environ.get("ANTHROPIC_API_KEY") or None
    )
    socrata_app_token: str | None = field(
        default_factory=lambda: os.environ.get("SOCRATA_APP_TOKEN") or None
    )

    # LLM layer. LEADMAKER_LLM_PROVIDER: auto | gemini | anthropic | openai_compat. "auto" picks Gemini
    # when a Gemini key is set, else Anthropic when ANTHROPIC_API_KEY is set, else an OpenAI-compatible
    # server when LEADMAKER_LLM_BASE_URL is set; with none of them the LLM enrichers disable themselves.
    llm_provider_setting: str = field(
        default_factory=lambda: (os.environ.get("LEADMAKER_LLM_PROVIDER") or "auto").strip().lower()
    )
    gemini_api_key: str | None = field(
        default_factory=lambda: os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or None
    )
    # Optional model override; when unset the model follows the provider (see DEFAULT_LLM_MODELS).
    llm_model_override: str | None = field(default_factory=lambda: os.environ.get("LEADMAKER_LLM_MODEL") or None)
    # Base URL override (required for openai_compat unless it is a local Ollama on :11434) and its key.
    llm_base_url: str | None = field(default_factory=lambda: os.environ.get("LEADMAKER_LLM_BASE_URL") or None)
    llm_api_key: str | None = field(default_factory=lambda: os.environ.get("LEADMAKER_LLM_API_KEY") or None)
    # Client-side budget per provider+model: requests per minute and per day (None -> provider default,
    # 0 -> unlimited). The day counter is persisted to llm_usage_file ("" disables persistence).
    llm_rpm: int | None = field(default_factory=lambda: _env_opt_int("LEADMAKER_LLM_RPM"))
    llm_rpd: int | None = field(default_factory=lambda: _env_opt_int("LEADMAKER_LLM_RPD"))
    llm_usage_file: str = field(
        default_factory=lambda: os.environ.get("LEADMAKER_LLM_USAGE_FILE", "data/llm_usage.json")
    )
    # Experimental custom extraction slots (JSON list of {key, label, type, description, enum?}).
    extraction_slots_path: str | None = field(
        default_factory=lambda: os.environ.get("LEADMAKER_EXTRACTION_SLOTS") or None
    )

    # Politeness / throughput knobs.
    http_timeout_s: float = field(default_factory=lambda: _env_float("LEADMAKER_HTTP_TIMEOUT", 30.0))
    max_retries: int = field(default_factory=lambda: _env_int("LEADMAKER_MAX_RETRIES", 4))
    # Minimum seconds between requests to the same host.
    per_host_interval_s: float = field(default_factory=lambda: _env_float("LEADMAKER_HOST_INTERVAL", 0.5))
    concurrency: int = field(default_factory=lambda: _env_int("LEADMAKER_CONCURRENCY", 6))
    # Re-fetch a GAF profile / enrichment only if older than this.
    profile_ttl_hours: float = field(default_factory=lambda: _env_float("LEADMAKER_PROFILE_TTL_HOURS", 24 * 7))
    enrichment_ttl_hours: float = field(
        default_factory=lambda: _env_float("LEADMAKER_ENRICHMENT_TTL_HOURS", 24 * 30)
    )
    user_agent_contact: str = field(
        default_factory=lambda: os.environ.get("LEADMAKER_CONTACT", "LeadMaker research crawler")
    )
    cache_dir: str = field(default_factory=lambda: os.environ.get("LEADMAKER_CACHE_DIR", "data/cache"))

    @property
    def llm_provider(self) -> str | None:
        """The provider the LLM layer will use, or None when nothing is configured."""
        p = self.llm_provider_setting
        if p in LLM_PROVIDERS:
            return p
        if p != "auto":
            raise ValueError(f"LEADMAKER_LLM_PROVIDER must be auto or one of {LLM_PROVIDERS}, got {p!r}")
        if self.gemini_api_key:
            return "gemini"
        if self.anthropic_api_key:
            return "anthropic"
        if self.llm_base_url:
            return "openai_compat"
        return None

    @property
    def llm_model(self) -> str:
        """Model id for the active provider: LEADMAKER_LLM_MODEL, else the provider default."""
        if self.llm_model_override:
            return self.llm_model_override
        return DEFAULT_LLM_MODELS.get(self.llm_provider or "anthropic", "")


def get_settings() -> Settings:
    return Settings()
