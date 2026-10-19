"""Timing badges: pure rules over a lead + its county's regional_signals rows."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from leadmaker.signals.timing import hazard_family, lead_services, point_in_geometry, timing_badges

NOW = datetime(2026, 10, 18, 18, 0, tzinfo=timezone.utc)
COUNTY = "34035"


def lead(services=(), tags=(), state="NJ", county=COUNTY, at=None):
    lat, lon = at or (None, None)
    return {
        "gaf_id": "1", "state": state, "county_fips": county, "tags": list(tags), "latitude": lat, "longitude": lon,
        "enrichment": {"website_crawl": {"status": "ok", "data": {"services": list(services)}}},
    }


def alert(event, start, end, county=COUNTY, **payload):
    return {"county_fips": county, "kind": "active_alert", "source": "nws", "external_id": event + str(start),
            "valid_from": start, "valid_to": end, "payload": {"event": event, "areaDesc": "Somerset", **payload}}


def history(*events, county=COUNTY):
    return {"county_fips": county, "kind": "storm_history", "source": "noaa_storm_events",
            "external_id": "summary_24m", "valid_from": NOW - timedelta(days=730), "valid_to": NOW,
            "payload": {"recent_events": list(events), "last_event_at": events[0]["date"] if events else None}}


def report(valid, kind="wind", event_type="TSTM WND DMG", location="Green Brook Twp", count=1, **extra):
    """A collapsed storm-history LSR event as storms.summarise stores it (valid = latest report, UTC)."""
    v = valid if isinstance(valid, str) else valid.strftime("%Y-%m-%dT%H:%M:%SZ")
    date = (datetime.fromisoformat(v.replace("Z", "+00:00")) - timedelta(hours=4)).date().isoformat()
    return {"date": date, "kind": kind, "event_type": event_type, "location": location, "source": "lsr",
            "valid": v, "first_valid": extra.pop("first_valid", v), "report_count": count, **extra}


def keys(badges):
    return {b["key"]: b for b in badges}


def test_hazard_families():
    assert hazard_family("Severe Thunderstorm Warning") == "thunderstorm"
    assert hazard_family("Wind Advisory") == "wind"
    assert hazard_family("High Wind Watch") == "wind"
    assert hazard_family("Winter Storm Warning") == "winter"
    assert hazard_family("Coastal Flood Advisory") == "coastal"
    assert hazard_family("Hurricane Warning") == "tropical"
    assert hazard_family("Tornado Watch") == "tornado"
    assert hazard_family("Flood Watch") == "flood"
    assert hazard_family("Frost Advisory") is None
    assert hazard_family("Special Weather Statement") is None
    assert hazard_family("Coastal Flood Statement") is None


def test_services_from_enrichment_and_tags():
    lead_ = lead(services=["roof_repair"], tags=[{"key": "service:new_construction", "value": True},
                                                 {"key": "storm_insurance", "value": True}])
    assert lead_services(lead_) == {"roof_repair", "new_construction", "storm_damage"}
    lead_["enrichment"]["website_crawl"]["status"] = "error"
    assert "roof_repair" not in lead_services(lead_)


def test_storm_roofer_gets_high_badge_for_active_warning():
    sig = [alert("Severe Thunderstorm Warning", NOW - timedelta(hours=1), NOW + timedelta(hours=1)),
           alert("Severe Thunderstorm Watch", NOW - timedelta(hours=3), NOW + timedelta(hours=4)),
           history(report(NOW - timedelta(minutes=20), location="Bridgewater"))]
    b = keys(timing_badges(lead(services=["storm_damage", "insurance_claims"]), sig, NOW))
    assert b["storm_response"]["severity"] == "high"
    assert "Severe Thunderstorm Warning in effect" in b["storm_response"]["reason"]
    assert "also Severe Thunderstorm Watch" in b["storm_response"]["reason"]
    assert "1 NWS storm report in this county confirms it" in b["storm_response"]["reason"]
    assert "TSTM WND DMG at Bridgewater" in b["storm_response"]["reason"]
    assert b["storm_response"]["source"] == "nws"
    assert timing_badges(lead(services=["storm_damage"]), sig, NOW)[0]["key"] == "storm_response"  # sorted first


def test_recently_ended_alert_counts_for_seven_days():
    ended3 = [alert("Wind Advisory", NOW - timedelta(days=3, hours=6), NOW - timedelta(days=3))]
    b = keys(timing_badges(lead(services=["emergency_service"]), ended3, NOW))
    assert b["storm_response"]["severity"] == "medium"  # advisory, not warning
    assert "3 days ago" in b["storm_response"]["reason"]
    ended9 = [alert("High Wind Warning", NOW - timedelta(days=9, hours=6), NOW - timedelta(days=9))]
    assert "storm_response" not in keys(timing_badges(lead(services=["emergency_service"]), ended9, NOW))


def test_non_storm_roofer_gets_low_context_badge_and_irrelevant_alerts_ignored():
    sig = [alert("Winter Storm Warning", NOW - timedelta(hours=2), NOW + timedelta(days=1)),
           alert("Frost Advisory", NOW - timedelta(hours=2), NOW + timedelta(hours=8))]
    b = keys(timing_badges(lead(services=["siding"]), sig, NOW))
    assert "storm_response" not in b
    assert b["weather_alert"]["severity"] == "low"
    frost = keys(timing_badges(lead(services=["storm_damage"]), sig[1:], NOW))
    assert "storm_response" not in frost and "weather_alert" not in frost


def test_new_construction_delay_note_only_for_extended_precip_or_winter():
    nc = lead(tags=[{"key": "service:new_construction", "value": True}])
    winter = [alert("Winter Storm Warning", NOW - timedelta(hours=2), NOW + timedelta(days=1))]
    assert keys(timing_badges(nc, winter, NOW))["weather_delays"]["severity"] == "medium"
    short_flash = [alert("Flash Flood Warning", NOW - timedelta(hours=1), NOW + timedelta(hours=2))]
    assert "weather_delays" not in keys(timing_badges(nc, short_flash, NOW))
    long_flood = [alert("Flood Watch", NOW - timedelta(hours=2), NOW + timedelta(hours=20))]
    assert "weather_delays" in keys(timing_badges(nc, long_flood, NOW))
    ended = [alert("Winter Storm Warning", NOW - timedelta(days=2), NOW - timedelta(days=1))]
    assert "weather_delays" not in keys(timing_badges(nc, ended, NOW))
    assert "weather_delays" not in keys(timing_badges(lead(services=["storm_damage"]), winter, NOW))


def test_recent_storm_from_history():
    recent = {"date": "2026-10-02", "kind": "wind", "event_type": "TSTM WND DMG", "location": "Green Brook Twp",
              "source": "lsr", "report_count": 2}
    old = {"date": "2026-08-07", "kind": "wind", "event_type": "Thunderstorm Wind", "location": "Somerville",
           "source": "ncei"}
    flood = {"date": "2026-10-10", "kind": "flood", "event_type": "COASTAL FLOOD", "location": "Bound Brook",
             "source": "lsr", "report_count": 3}
    b = keys(timing_badges(lead(services=["storm_damage"]), [history(flood, recent, old)], NOW))
    assert b["recent_storm"]["severity"] == "medium"
    assert "2 roof-relevant storm reports" in b["recent_storm"]["reason"]  # the flood is not roof-relevant
    assert "Green Brook Twp" in b["recent_storm"]["reason"]
    assert keys(timing_badges(lead(), [history(recent)], NOW))["recent_storm"]["severity"] == "low"
    assert "recent_storm" not in keys(timing_badges(lead(), [history(old)], NOW))


def test_season_notes_by_month_and_state():
    def season(month, state="NJ"):
        return keys(timing_badges(lead(state=state), [], NOW.replace(month=month, day=15))).get("season")

    assert season(2)["label"].startswith("Q1")
    assert "3/31" in season(3)["reason"]
    assert season(7)["label"].startswith("In season")
    assert "pre-buy" in season(11)["reason"]
    assert season(12)["label"].startswith("Pre-buy")
    assert season(7, state="PA") is None
    assert season(7)["severity"] == "info" and season(7)["source"] == "calendar"


def test_signals_for_other_counties_are_ignored_and_strings_parse():
    sig = [alert("Tornado Warning", (NOW - timedelta(hours=1)).isoformat(), (NOW + timedelta(hours=1)).isoformat(),
                 county="34003"), history(report(NOW, kind="tornado", event_type="TORNADO"), county="34003")]
    assert not {"storm_response", "recent_storm"} & set(keys(timing_badges(lead(services=["storm_damage"]), sig, NOW)))
    sig[0]["county_fips"] = sig[1]["county_fips"] = COUNTY
    assert keys(timing_badges(lead(services=["storm_damage"]), sig, NOW))["storm_response"]["severity"] == "high"
    for b in timing_badges(lead(services=["storm_damage"]), sig, NOW):
        assert set(b) == {"key", "label", "reason", "source", "severity"}


def test_ended_watch_is_not_a_storm_but_active_watch_is():
    # Real case (2026-10-16): a Severe Thunderstorm Watch cancelled with no warning in the county.
    ended = [alert("Severe Thunderstorm Watch", NOW - timedelta(days=2), NOW - timedelta(days=1, hours=20))]
    assert not {"storm_response", "weather_alert"} & set(keys(timing_badges(lead(services=["storm_damage"]), ended, NOW)))
    assert "weather_alert" not in keys(timing_badges(lead(services=["siding"]), ended, NOW))
    active = [alert("Severe Thunderstorm Watch", NOW - timedelta(hours=1), NOW + timedelta(hours=4))]
    assert keys(timing_badges(lead(services=["storm_damage"]), active, NOW))["storm_response"]["severity"] == "medium"
    # A warning that ended inside the 7-day window still counts; the ended watch is not cited alongside it.
    warned = ended + [alert("Severe Thunderstorm Warning", NOW - timedelta(days=2), NOW - timedelta(days=1, hours=22)),
                      history(report(NOW - timedelta(days=1, hours=23)))]
    b = keys(timing_badges(lead(services=["storm_damage"]), warned, NOW))["storm_response"]
    assert b["severity"] == "high" and "also" not in b["reason"]


def test_routine_winter_and_coastal_advisories_do_not_trigger_storm_response():
    roofer = lead(services=["storm_damage"])
    for event in ("Winter Weather Advisory", "Coastal Flood Advisory", "Winter Storm Watch"):
        sig = [alert(event, NOW - timedelta(hours=1), NOW + timedelta(hours=10))]
        assert "storm_response" not in keys(timing_badges(roofer, sig, NOW)), event
    for event in ("Coastal Flood Warning", "Ice Storm Warning"):
        sig = [alert(event, NOW - timedelta(hours=1), NOW + timedelta(hours=10))]
        assert keys(timing_badges(roofer, sig, NOW))["storm_response"]["severity"] == "medium", event  # unconfirmed
    ice = [alert("Ice Storm Warning", NOW - timedelta(hours=1), NOW + timedelta(hours=10)),
           history(report(NOW, kind="winter", event_type="SNOW/ICE DMG"))]
    assert keys(timing_badges(roofer, ice, NOW))["storm_response"]["severity"] == "high"
    # The advisory still reaches new-construction crews as a delay note.
    nc = lead(tags=[{"key": "service:new_construction", "value": True}])
    sig = [alert("Winter Weather Advisory", NOW - timedelta(hours=1), NOW + timedelta(hours=10))]
    assert "weather_delays" in keys(timing_badges(nc, sig, NOW))


def test_storm_tag_does_not_invent_a_listed_service():
    tags = [{"key": "service:insurance_claims", "value": True}, {"key": "storm_insurance", "value": True}]
    assert lead_services(lead(tags=tags)) == {"insurance_claims"}
    assert "storm_damage" in lead_services(lead(tags=[{"key": "storm_insurance", "value": True}]))


def test_flood_duration_uses_onset_and_future_alerts_say_when():
    nc = lead(tags=[{"key": "service:new_construction", "value": True}])
    # Issued 20 h ahead, but the flood threat itself lasts 4 h: not "extended" precipitation.
    early = [alert("Flood Watch", NOW - timedelta(hours=2), NOW + timedelta(hours=22),
                   onset=(NOW + timedelta(hours=18)).isoformat())]
    assert "weather_delays" not in keys(timing_badges(nc, early, NOW))
    future = [alert("High Wind Warning", NOW - timedelta(hours=1), NOW + timedelta(hours=30),
                    onset=(NOW + timedelta(hours=12)).isoformat())]
    reason = keys(timing_badges(lead(services=["storm_damage"]), future, NOW))["storm_response"]["reason"]
    assert "High Wind Warning from " in reason and "in effect" not in reason


# Real 2026-10-16 polygons (api.weather.gov, rounded to 0.01 deg as NWS draws them).
# Upton NY "Severe Thunderstorm Warning for... Northern Westchester County... Orange County... Putnam County".
WESTCHESTER_SVR = {"type": "MultiPolygon", "coordinates": [[[
    [-74.61, 41.5], [-74.48, 41.5], [-74.42, 41.57], [-74.26, 41.63], [-74.25, 41.6], [-74.13, 41.58],
    [-74.13, 41.61], [-74.05, 41.58], [-73.95, 41.59], [-74.0, 41.45], [-73.93, 41.49], [-73.7, 41.51],
    [-73.6, 41.23], [-73.97, 41.25], [-73.94, 41.29], [-73.98, 41.32], [-74.08, 41.25], [-74.52, 41.27],
    [-74.66, 41.34], [-74.68, 41.46], [-74.61, 41.5]]]]}
# Mount Holly's last Update (18:06 EDT) of the warning first issued for "...Southern Morris County...".
MORRIS_SVR = {"type": "MultiPolygon", "coordinates": [[[
    [-74.76, 40.66], [-74.86, 40.64], [-74.94, 40.64], [-74.87, 40.79], [-74.83, 40.82], [-74.83, 40.83],
    [-74.68, 40.86], [-74.65, 40.86], [-74.49, 40.88], [-74.44, 40.69], [-74.76, 40.66]]]]}
OCT16_SVR = datetime(2026, 10, 16, 21, 24, tzinfo=timezone.utc)


def test_point_in_polygon_ray_casting():
    square = {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
                                                 [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]}
    assert point_in_geometry(1, 1, square) is True
    assert point_in_geometry(5, 5, square) is False  # in the hole
    assert point_in_geometry(11, 5, square) is False
    assert point_in_geometry(1, 1, None) is None and point_in_geometry(1, 1, {"type": "Point"}) is None
    assert point_in_geometry(41.2901, -73.9204, WESTCHESTER_SVR) is True  # Peekskill, northern Westchester


def test_partial_county_warning_is_only_nearby_outside_its_polygon():
    # Audit: storm_response HIGH fired in Yonkers, New Rochelle, Dobbs Ferry and Elmsford for the warning
    # that named only "Northern Westchester County"; and in Pequannock, Pompton Plains and Montville for
    # Morris, whose final polygon stops at -74.44.
    now = datetime(2026, 10, 18, 19, 30, tzinfo=timezone.utc)
    west = [alert("Severe Thunderstorm Warning", OCT16_SVR, OCT16_SVR + timedelta(minutes=66), county="36119",
                  geometry=WESTCHESTER_SVR, areaDesc="Orange, NY; Putnam, NY; Westchester, NY")]
    for city, at in {"Yonkers": (40.957543, -73.873863), "New Rochelle": (40.947618, -73.79613),
                     "Dobbs Ferry": (41.012661, -73.877182), "Elmsford": (41.052417, -73.821167)}.items():
        b = keys(timing_badges(lead(services=["storm_damage"], county="36119", state="NY", at=at), west, now))
        sr = b["storm_response"]
        assert sr["severity"] == "low" and sr["label"].startswith("Storm nearby: Severe Thunderstorm Warning"), city
        assert "nearby (it covered part of this county, not this address)" in sr["reason"], city
        assert "in this county" not in sr["reason"], city
        plain = keys(timing_badges(lead(services=["siding"], county="36119", state="NY", at=at), west, now))
        assert plain["weather_alert"]["label"] == "Severe weather nearby: Severe Thunderstorm Warning", city
    morris = [alert("Severe Thunderstorm Warning", OCT16_SVR, OCT16_SVR + timedelta(minutes=51), county="34027",
                    geometry=MORRIS_SVR)]
    for city, at in {"Pequannock": (40.947991, -74.291624), "Pompton Plains": (40.969339, -74.292396),
                     "Montville": (40.883314, -74.364834)}.items():
        sr = keys(timing_badges(lead(services=["storm_damage"], county="34027", at=at), morris, now))["storm_response"]
        assert sr["severity"] == "low" and "nearby" in sr["reason"], city
    # Inside the polygon (Peekskill) it is a storm-response call; no point or no polygon -> county-wide.
    inside = keys(timing_badges(lead(services=["storm_damage"], county="36119", at=(41.2901, -73.9204)), west, now))
    assert inside["storm_response"]["severity"] == "medium" and "in this county" in inside["storm_response"]["reason"]
    no_point = keys(timing_badges(lead(services=["storm_damage"], county="36119"), west, now))
    assert no_point["storm_response"]["severity"] == "medium"
    zone = [dict(west[0], payload={**west[0]["payload"], "geometry": None})]
    yonkers = lead(services=["storm_damage"], county="36119", at=(40.957543, -73.873863))
    assert "in this county" in keys(timing_badges(yonkers, zone, now))["storm_response"]["reason"]
    # A county-wide watch still in effect outranks the nearby warning for the address it covers.
    watch = alert("Severe Thunderstorm Watch", now - timedelta(hours=1), now + timedelta(hours=3), county="36119")
    b = keys(timing_badges(yonkers, west + [watch], now))["storm_response"]
    assert b["severity"] == "medium" and "Severe Thunderstorm Watch in effect" in b["reason"]
    assert "also" not in b["reason"]  # the warning did not cover this address


def test_warning_is_high_only_with_a_storm_report_in_the_window():
    # Audit: the 2026-10-16 warnings for Morris / Somerset / Westchester were "SOURCE...Radar indicated."
    # and no damage was reported in those counties, yet storm_response was high.
    now = datetime(2026, 10, 18, 19, 30, tzinfo=timezone.utc)
    end = datetime(2026, 10, 16, 22, 15, tzinfo=timezone.utc)
    svr = alert("Severe Thunderstorm Warning", datetime(2026, 10, 16, 22, 6, tzinfo=timezone.utc), end,
                onset="2026-10-16T18:06:00-04:00")
    roofer = lead(services=["storm_damage", "insurance_claims"])
    # Somerset's storm history: last roof-relevant report 2026-08-07, nothing on Oct 16.
    quiet = keys(timing_badges(roofer, [svr, history(report("2026-08-07T21:19:00Z"))], now))["storm_response"]
    assert quiet["severity"] == "medium"
    assert "no NWS storm reports in this county confirm damage yet" in quiet["reason"]
    # Hunterdon's "TSTM WND DMG ... Readington Twp Trees down." at 22:05Z, had it been in this county.
    hit = report("2026-10-16T22:05:00Z", location="Readington Twp", count=2, first_valid="2026-10-16T22:00:00Z")
    b = keys(timing_badges(roofer, [svr, history(hit)], now))["storm_response"]
    assert b["severity"] == "high" and "2 NWS storm reports in this county confirm it" in b["reason"]
    assert "Readington Twp, Oct 16 18:05 ET" in b["reason"]
    late = report(end + timedelta(hours=6, minutes=5))
    early = report(datetime(2026, 10, 16, 15, 0, tzinfo=timezone.utc))
    flood = report("2026-10-16T22:30:00Z", kind="flood", event_type="FLASH FLOOD")
    for miss in (late, early, flood):
        assert keys(timing_badges(roofer, [svr, history(miss)], now))["storm_response"]["severity"] == "medium"
    edge = report(end + timedelta(hours=5, minutes=55))
    assert keys(timing_badges(roofer, [svr, history(edge)], now))["storm_response"]["severity"] == "high"


def test_roof_repair_alone_is_not_storm_response():
    # Audit: 5 of 18 storm_response badges fired on "Lists roof repair" alone (e.g. Acorn Home
    # Improvements, Whippany; Feher Home Solutions, Boonton).
    sig = [alert("Severe Thunderstorm Warning", NOW - timedelta(hours=1), NOW + timedelta(hours=1))]
    b = keys(timing_badges(lead(services=["roof_repair"]), sig, NOW))
    assert "storm_response" not in b and b["weather_alert"]["severity"] == "low"
    both = keys(timing_badges(lead(services=["roof_repair", "emergency_service"]), sig, NOW))["storm_response"]
    assert "Lists emergency service:" in both["reason"]  # roof repair is no longer cited


def test_recent_storm_needs_more_than_one_lone_report():
    # Audit: recent_storm was on 277/424 leads because one NON-TSTM WND DMG report counted, e.g. Passaic's
    # only report "Downed tree on Route 23 Paterson Hamburg Turnpike." (4 W Bloomingdale, 2026-09-27).
    lone = report("2026-09-27T08:46:00Z", event_type="NON-TSTM WND DMG", location="4 W Bloomingdale",
                  narrative="Downed tree on Route 23 Paterson Hamburg Turnpike.")
    assert "recent_storm" not in keys(timing_badges(lead(), [history(lone)], NOW))
    bedford = report("2026-09-26T20:31:00Z", event_type="NON-TSTM WND DMG", location="2 W Bedford",
                     narrative="Trees and wires down across South Bedford Road.")
    assert "recent_storm" not in keys(timing_badges(lead(), [history(bedford)], NOW))
    # Old payloads without report_count count each event once: two events are two reports.
    assert "recent_storm" in keys(timing_badges(lead(), [history(lone, bedford)], NOW))
    # One report is enough when it is a measured severe gust, cites a structure, is hail >= 1" or a tornado.
    gust = report("2026-09-27T11:41:00Z", event_type="NON-TSTM WND GST", location="Sea Bright", magnitude=66.0,
                  unit="mph")  # payload before gust_mph: derived from the measured magnitude
    weak = report("2026-09-27T14:15:00Z", event_type="NON-TSTM WND GST", magnitude=49.0, unit="mph")
    home = report("2026-07-28T16:38:00Z", location="3 ESE Laureldale", structure=True,
                  narrative="Delayed report. A tree fell through a home on Wanner Road in Alsace Township.")
    hail = report("2026-10-01T22:20:00Z", kind="hail", event_type="HAIL", magnitude=1.0, unit="inch")
    small = report("2026-10-01T14:43:00Z", kind="hail", event_type="HAIL", magnitude=0.88, unit="inch")
    tornado = report("2026-10-01T20:00:00Z", kind="tornado", event_type="TORNADO")
    for ok in (gust, hail, tornado):
        assert "recent_storm" in keys(timing_badges(lead(), [history(ok)], NOW)), ok["event_type"]
    assert "recent_storm" in keys(timing_badges(lead(), [history(home)], datetime(2026, 8, 10, tzinfo=timezone.utc)))
    for no in (weak, small):
        assert "recent_storm" not in keys(timing_badges(lead(), [history(no)], NOW)), no["magnitude"]
    assert "recent_storm" in keys(timing_badges(lead(), [history(dict(lone, gust_mph=66))], NOW))


def test_recent_storm_counts_reports_and_names_the_latest():
    # Audit: Bergen's reason said "1 roof-relevant storm report" for the 2026-09-26 event that stands for
    # 3 reports (1 ENE Park Ridge 09:43Z, Montvale 10:20Z, 3 W Ramsey 12:37Z) and named the first as latest.
    bergen = report("2026-09-26T12:37:00Z", event_type="NON-TSTM WND DMG", location="3 W Ramsey", count=3,
                    first_valid="2026-09-26T09:43:00Z")
    older = report("2026-09-25T23:10:00Z", event_type="NON-TSTM WND DMG", location="Bloomfield")
    r = keys(timing_badges(lead(county="34003"), [history(bergen, older, county="34003")], NOW))["recent_storm"]
    assert r["reason"].startswith("4 roof-relevant storm reports in this county in the last 30 days; "
                                  "latest 2026-09-26 NON-TSTM WND DMG at 3 W Ramsey (NWS storm report).")
    # Same-day events: the one with the later report time is "latest" whatever the list order.
    gust = report("2026-09-26T13:30:00Z", event_type="NON-TSTM WND GST", location="Teterboro", gust_mph=60)
    r = keys(timing_badges(lead(county="34003"), [history(bergen, gust, county="34003")], NOW))["recent_storm"]
    assert "latest 2026-09-26 NON-TSTM WND GST at Teterboro" in r["reason"]
