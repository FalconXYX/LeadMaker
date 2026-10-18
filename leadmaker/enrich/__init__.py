"""Secondary-source enrichers, loaded lazily so a broken/optional one can't break the rest."""

from __future__ import annotations

import importlib
import logging

from ..config import Settings
from .base import Enricher, LeadContext

log = logging.getLogger(__name__)

# Order here is only a tie-break; real ordering comes from each enricher's depends_on.
REGISTRY: dict[str, str] = {
    "google_places": "leadmaker.enrich.google_places:GooglePlacesEnricher",
    "osm": "leadmaker.enrich.osm:OsmEnricher",
    "ny_dos": "leadmaker.enrich.ny_dos:NyDosEnricher",
    "nyc_dcwp": "leadmaker.enrich.nyc_dcwp:NycDcwpEnricher",
    # USDOT carrier census: company officers + email + fleet size; best free NJ decision-maker source.
    "fmcsa": "leadmaker.enrich.fmcsa:FmcsaEnricher",
    # BBB public profiles (prototype; personal-use clause): named principals, licences, rating, start date.
    "bbb": "leadmaker.enrich.bbb:BbbEnricher",
    "website_discovery": "leadmaker.enrich.website_discovery:WebsiteDiscoveryEnricher",
    "website_crawl": "leadmaker.enrich.website_crawl:WebsiteCrawlEnricher",
    # Wayback/RDAP web age, CMS, ad pixels, financing offers, manufacturer brands (research: digital_presence).
    "web_signals": "leadmaker.enrich.web_signals:WebSignalsEnricher",
    "llm_extract": "leadmaker.enrich.llm_extract:LlmExtractEnricher",
}


def load_enricher_class(name: str) -> type[Enricher]:
    module, _, cls = REGISTRY[name].partition(":")
    return getattr(importlib.import_module(module), cls)


def topo_order(classes: dict[str, type[Enricher]]) -> list[str]:
    """Order enrichers so dependencies run first (deps outside the selection are ignored)."""
    ordered: list[str] = []
    visiting: set[str] = set()

    def visit(n: str) -> None:
        if n in ordered:
            return
        if n in visiting:
            raise ValueError(f"enricher dependency cycle at {n}")
        visiting.add(n)
        for d in classes[n].depends_on:
            if d in classes:
                visit(d)
        visiting.discard(n)
        ordered.append(n)

    for n in REGISTRY:
        if n in classes:
            visit(n)
    return ordered


def load_enrichers(settings: Settings, names: list[str] | None = None) -> list[Enricher]:
    selected = names or list(REGISTRY)
    unknown = [n for n in selected if n not in REGISTRY]
    if unknown:
        raise ValueError(f"unknown enrichers: {unknown}; available: {list(REGISTRY)}")
    classes: dict[str, type[Enricher]] = {}
    for n in selected:
        try:
            classes[n] = load_enricher_class(n)
        except Exception as e:  # missing optional dependency, syntax error, ...
            log.error("could not load enricher %s: %s", n, e)
    return [classes[n](settings) for n in topo_order(classes)]


__all__ = ["Enricher", "LeadContext", "REGISTRY", "load_enrichers", "topo_order"]
