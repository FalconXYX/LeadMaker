"""Enricher registry: lazy loading, dependency ordering and failure isolation (offline)."""

from __future__ import annotations

import logging

import pytest

from leadmaker.config import Settings
from leadmaker.enrich import REGISTRY, load_enricher_class, load_enrichers, topo_order
from leadmaker.enrich.base import Enricher


def _fake(name: str, deps: tuple[str, ...] = ()) -> type[Enricher]:
    async def enrich(self, ctx, http):  # pragma: no cover - never called
        return self.no_match()

    return type(f"Fake_{name}", (Enricher,), {"name": name, "depends_on": deps, "enrich": enrich})


def _assert_deps_first(order: list[str], classes: dict[str, type[Enricher]]) -> None:
    for n in order:
        for d in classes[n].depends_on:
            if d in classes:
                assert order.index(d) < order.index(n), (d, n, order)


# -- registry integrity -----------------------------------------------------------------------------

@pytest.mark.parametrize("key", list(REGISTRY))
def test_every_registry_entry_loads_an_enricher_named_after_its_key(key):
    cls = load_enricher_class(key)
    assert issubclass(cls, Enricher) and cls.name == key


def test_every_declared_dependency_is_a_registered_enricher():
    for key in REGISTRY:
        for dep in load_enricher_class(key).depends_on:
            assert dep in REGISTRY, f"{key} depends on unknown enricher {dep!r}"
            assert dep != key


def test_full_registry_orders_dependencies_first():
    classes = {k: load_enricher_class(k) for k in REGISTRY}
    order = topo_order(classes)
    assert sorted(order) == sorted(REGISTRY)
    _assert_deps_first(order, classes)
    # REGISTRY lists ny_dos before nyc_dcwp; the dependency must win over that tie-break.
    assert list(REGISTRY).index("ny_dos") < list(REGISTRY).index("nyc_dcwp")
    assert order.index("nyc_dcwp") < order.index("ny_dos")


# -- topo_order ---------------------------------------------------------------------------------------

def test_independent_enrichers_keep_registry_order():
    classes = {k: _fake(k) for k in ("llm_extract", "osm", "google_places")}
    assert topo_order(classes) == ["google_places", "osm", "llm_extract"]


def test_transitive_dependencies_are_pulled_ahead():
    classes = {
        "google_places": _fake("google_places", ("llm_extract",)),
        "llm_extract": _fake("llm_extract", ("website_crawl",)),
        "website_crawl": _fake("website_crawl"),
    }
    assert topo_order(classes) == ["website_crawl", "llm_extract", "google_places"]


def test_dependencies_outside_the_selection_are_ignored():
    classes = {"ny_dos": _fake("ny_dos", ("nyc_dcwp",)), "osm": _fake("osm")}
    assert topo_order(classes) == ["osm", "ny_dos"]


def test_shared_dependency_is_emitted_once():
    classes = {"website_discovery": _fake("website_discovery"),
               "website_crawl": _fake("website_crawl", ("website_discovery",)),
               "web_signals": _fake("web_signals", ("website_discovery", "website_crawl"))}
    order = topo_order(classes)
    assert order == ["website_discovery", "website_crawl", "web_signals"]


def test_dependency_cycle_is_rejected():
    classes = {"osm": _fake("osm", ("bbb",)), "bbb": _fake("bbb", ("fmcsa",)), "fmcsa": _fake("fmcsa", ("osm",))}
    with pytest.raises(ValueError, match="enricher dependency cycle at osm"):
        topo_order(classes)


def test_self_dependency_is_a_cycle():
    with pytest.raises(ValueError, match="cycle at bbb"):
        topo_order({"bbb": _fake("bbb", ("bbb",))})


# -- load_enrichers ---------------------------------------------------------------------------------

def test_unknown_enricher_name_is_rejected_with_available_list():
    with pytest.raises(ValueError, match=r"unknown enrichers: \['nope'\]; available: \[") as exc:
        load_enrichers(Settings(), ["osm", "nope"])
    assert "'website_crawl'" in str(exc.value)


def test_selection_is_instantiated_in_dependency_order_with_settings():
    s = Settings(socrata_app_token="tok")
    es = load_enrichers(s, ["ny_dos", "osm", "nyc_dcwp"])
    assert [e.name for e in es] == ["osm", "nyc_dcwp", "ny_dos"]
    assert all(isinstance(e, Enricher) and e.settings is s for e in es)


def test_no_selection_loads_every_registered_enricher():
    es = load_enrichers(Settings())
    assert sorted(e.name for e in es) == sorted(REGISTRY)
    assert len({id(e) for e in es}) == len(REGISTRY)


def test_broken_enricher_is_logged_and_skipped_without_breaking_the_rest(monkeypatch, caplog):
    monkeypatch.setitem(REGISTRY, "nyc_dcwp", "leadmaker.enrich.does_not_exist:Nope")
    monkeypatch.setitem(REGISTRY, "osm", "leadmaker.enrich.osm:NoSuchClass")
    with caplog.at_level(logging.ERROR, logger="leadmaker.enrich"):
        es = load_enrichers(Settings(), ["ny_dos", "nyc_dcwp", "osm", "fmcsa"])
    assert [e.name for e in es] == ["ny_dos", "fmcsa"]  # ny_dos still runs without its optional dependency
    msgs = [r.getMessage() for r in caplog.records]
    assert any(m.startswith("could not load enricher nyc_dcwp:") and "does_not_exist" in m for m in msgs)
    assert any(m.startswith("could not load enricher osm:") and "NoSuchClass" in m for m in msgs)


def test_duplicate_names_in_selection_load_once():
    es = load_enrichers(Settings(), ["osm", "osm"])
    assert [e.name for e in es] == ["osm"]
