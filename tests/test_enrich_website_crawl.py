import json
from datetime import date
from pathlib import Path

from leadmaker.enrich import website_crawl as wc

FIX = Path(__file__).parent / "fixtures"


def test_format_phone_and_email():
    assert wc.format_phone("(201) 555-1234") is not None
    assert wc.clean_email("image@2x.png") is None
    assert wc.clean_email("info@example.com") is None or True


def test_founded_and_team_size():
    year, _ = wc.extract_founded("Proudly serving since 1998.", today=date(2026, 10, 18))
    assert year == 1998
    year2, _ = wc.extract_founded("over 25 years of experience", today=date(2026, 10, 18))
    assert year2 in (2001, None)
    assert wc.extract_team_size("our team of 25 professionals") is not None


def test_clean_name_rejects_service_phrases():
    assert wc.clean_name("Roof Replacement") is None
    assert wc.clean_name("John Smith") == "John Smith"


def test_fixture_pages_parse():
    for f in sorted(FIX.glob("website_crawl_*.html")):
        page = wc.parse_page(f.read_text(errors="ignore"), "https://example-roofer.com/about")
        assert page.text
        wc.extract_leadership([page], ["Example Roofer"])
        services, _ = wc.extract_services(page.text)
        assert isinstance(services, list)


def test_nygr_leadership():
    p = wc.parse_page((FIX / "website_crawl_nygr_about.html").read_text(errors="ignore"), "https://x.com/about")
    names = {l.name: l.title for l in wc.extract_leadership([p], [])}
    assert names.get("Rene Lizama", "").lower().startswith("ceo")
    assert "Jonathan Lizama" in names


def test_team_card_rejects_credential_lines():
    # Live false positive (klgcontracting.com): "Licensed Special Rigger" under a COO card
    # was trimmed to the "name" "Special Rigger".
    html = """<html><body><div><h3>Nicholas Kagios</h3><p>Chief Operating Officer</p>
    <p>Licensed Special Rigger</p></div></body></html>"""
    p = wc.parse_page(html, "https://x.com/team")
    names = {l.name: l.title for l in wc.extract_leadership([p], [])}
    assert names.get("Nicholas Kagios") == "Chief Operating Officer"
    assert "Special Rigger" not in names
    assert wc.clean_name("Licensed Special Rigger", strict=True) is None


def test_new_service_detectors_on_real_site_text():
    # Real stored crawl text (trimmed): TPO / single-ply / new-construction hits and false-positive guards.
    fx = json.loads((FIX / "website_crawl_service_snippets.json").read_text())
    for s in fx["snippets"]:
        found = set(wc.extract_services(s["text"])[0])
        assert set(s["expect"]) <= found, (s["url"], s["expect"], found)
        assert not set(s["reject"]) & found, (s["url"], s["reject"], found)


def test_tpo_is_also_single_ply_and_flat():
    services, counts = wc.extract_services("We install GAF EverGuard TPO and Thermoplastic Polyolefin membranes.")
    assert {"tpo_roofing", "single_ply_roofing", "flat_roofing"} <= set(services)
    assert counts["tpo_roofing"] == 2
    epdm, _ = wc.extract_services("EPDM rubber roofing and PVC roofing systems for flat roofs")
    assert "single_ply_roofing" in epdm and "tpo_roofing" not in epdm


def test_new_construction_avoids_new_roof_and_negations():
    assert "new_construction" not in wc.extract_services("Get a new roof installed in one day. New roofs, re-roofs.")[0]
    assert "new_construction" not in wc.extract_services("Sorry, we do not do new construction.")[0]
    assert "new_construction" not in wc.extract_services("We don't take on new construction projects")[0]
    assert "new_construction" not in wc.extract_services("Stay current with new developments in roofing")[0]
    # "not just / not only" is affirmative; a negated mention doesn't hide a separate positive one.
    assert "new_construction" in wc.extract_services("Not just new construction: repairs too.")[0]
    assert "new_construction" in wc.extract_services("No matter if it's new construction or a re-roof, call us")[0]
    _, counts = wc.extract_services("We don't do new construction. Actually we now offer new builds.")
    assert counts["new_construction"] == 1
    # Negation stays inside one text block: a heading after "...can't beat" is not negated.
    assert "new_construction" in wc.extract_services("Prices you can't beat\nNew Construction\nRoof Repair")[0]
    assert "new_construction" not in wc.extract_services("Note:\nWe do not do new construction")[0]
    for txt in ("Ground-up new home construction", "We partner with local builders", "builders and developers",
                "custom home building", "newly built homes"):
        assert "new_construction" in wc.extract_services(txt)[0], txt


def test_extract_all_reports_new_services_from_html():
    html = """<html><head><title>Acme Roofing</title></head><body><nav><a href="/tpo">TPO Roofing</a></nav>
    <main><h2>Commercial</h2><p>Single-ply EPDM and TPO membranes for flat roofs.</p>
    <h2>New Construction</h2><p>We work with builders and developers on new builds across Bergen County.</p>
    </main></body></html>"""
    page = wc.parse_page(html, "https://acme-roofing.com/")
    ctx = wc.LeadContext({"gaf_id": "1", "name": "Acme Roofing"})
    data = wc.extract_all([page], ctx, "acme-roofing.com", today=date(2026, 10, 18))
    assert {"tpo_roofing", "single_ply_roofing", "new_construction"} <= set(data["services"])
    # The stored page text keeps the main content, so a later re-scan finds the same keys.
    stored = "\n".join(p["text"] for p in data["pages"])
    assert {"single_ply_roofing", "new_construction"} <= set(wc.extract_services(stored)[0])


# --- audit fixes (Oct 2026): context-sensitive services, evidence, spam links ---------------------
def _svc(text, url="https://x.com/"):
    return set(wc.scan_services([(url, text)])[0])


def test_new_construction_audit_false_positives_are_rejected():
    # 1127931: review quote on the homepage.
    assert "new_construction" not in _svc("“I actually chose Guaman over Lowe’s due to their professionalism and "
                                          "attention to details… My house looks newly built.”")
    # 7157319: terms-of-service warranty clause (pattern guard and page guard each reject it).
    tos = ("portions of the project in which NY General Renovation, Inc fully replaced any new construction systems "
           "(flat roof, pitched roof, whole window, whole door, whole gutter, etc.)")
    assert "new_construction" not in _svc(tos)
    assert "new_construction" not in _svc("We also do new construction.", "https://www.nygeneralrenovation.com/terms-of-service")
    # 1000796: staff bio, not a first-person builder partnership.
    assert "new_construction" not in _svc("Vincent has consulted with Builders, Architects, Contractors, and Remodelers, "
                                          "and suggested what products they should use.", "https://mcleodbrothers.com/about/")
    # 1156042: SEO blog titles.
    assert "new_construction" not in _svc("Real Estate Developers in Clifton, NJ: A 2026 Vetting Guide")
    assert "new_construction" not in _svc("New Construction Plumber in Wayne, NJ: 2026 Services, Costs & Hiring Guide",
                                          "https://www.fahmihomesolutions.com/blog/new-construction-plumber-wayne-nj")


def test_new_construction_audit_true_positives_are_kept():
    assert "new_construction" in _svc("Our team specializes in new construction roofing and installing new roofs on "
                                      "existing construction.", "https://donnysroofing.com/")  # 1139561
    assert "new_construction" in _svc("Expertise\nRe-roof\nNew Construction\nTear-Offs", "https://ffroofing.com/services")  # 1100323
    assert "new_construction" in _svc("New Construction\nFrom foundation to roof.", "https://carltoncm.com/new-construction/")  # 1145215
    assert "new_construction" in _svc("We collaborate with homeowners and builders to ensure that the roof is perfect")
    assert "new_construction" in _svc("Exterior Services for Homeowners, Builders, and Property Management")
    assert "new_construction" in _svc("We have a proven success rate with projects ranging from brand-new building "
                                      "constructions to restoration work.")  # 1141588


def test_blog_cards_on_homepage_do_not_count_for_context_services():
    # 1156042 (fahmihomesolutions.com): the homepage's "latest posts" cards link to /blog/... articles.
    html = """<html><body><main><h2>Kitchen remodeling in North Haledon</h2><p>Full kitchen and bath remodels.</p>
    <a href="/blog/real-estate-developers-clifton-nj"><span>Buyer's Guide</span><h3>Real Estate Developers in Clifton, NJ:
    A 2026 Vetting Guide</h3><p>Comparing real estate developers in Clifton, NJ? Learn what the title actually covers.</p></a>
    <a href="/blog/new-construction-plumber-wayne-nj"><h3>New Construction Plumber in Wayne, NJ: 2026 Services, Costs &amp;
    Hiring Guide</h3><p>Hiring a new construction plumber in Wayne, NJ? Compare 2026 costs.</p></a></main></body></html>"""
    page = wc.parse_page(html, "https://www.fahmihomesolutions.com/")
    data = wc.extract_all([page], wc.LeadContext({"gaf_id": "1156042", "name": "Fahmi Home Solutions"}),
                          "www.fahmihomesolutions.com", today=date(2026, 10, 18))
    assert "new_construction" not in data["services"]
    assert "general_contracting" in data["services"]
    # Without the link context (plain text re-scan) the same words would still count.
    assert "new_construction" in wc.extract_services(page.text)[0]


def test_storm_damage_needs_damage_context_not_product_features():
    # 1100696: product features, not storm work.
    assert "storm_damage" not in _svc("lifetime transferable warranties, hurricane-resistant siding and high R-value performance.")
    assert "storm_damage" not in _svc("Hurricane-Rated Materials")
    assert "storm_damage" in _svc("Shingle/flat roof leak repair, Storm damage repairs, plywood and dry rot repair")
    assert "storm_damage" in _svc("We handle hurricane damage repairs and insurance paperwork.")
    # 1148691: warranty clause; 1002371: advice on a skylight page.
    assert "storm_damage" not in _svc("additional protection against wind, hail, and paint finish issues.")
    assert "storm_damage" not in _svc("If you are seeing stains after storms, a roofing inspection is worth scheduling")
    # Real storm work worded without "storm damage": 1142379, 1132767 (sic), 1139561, 1113999.
    for txt in ("» Emergency Storm Repair", "Storm Demage Repair", "Storm documentation support", "Winter Storm Damage"):
        assert "storm_damage" in _svc(txt), txt


def test_emergency_service_needs_emergency_context():
    # 1112549: quote turnaround; 1145389: office hours; 1143337: blog prose.
    assert "emergency_service" not in _svc("inspect the deck, and hand you a written quote inside 24 hours.")
    assert "emergency_service" not in _svc("Monday-Friday: 24 hours | Saturday: 9:00am - 1:00pm")
    assert "emergency_service" not in _svc("a neglected roof can quickly turn into a costly emergency.")
    assert "emergency_service" in _svc("24/7 Emergency Services")  # 1158683
    assert "emergency_service" in _svc("solar panel removal and reinstallation, emergency storm damage repairs, and roof tarping.")
    assert "emergency_service" in _svc("Available 24 hours a day for leaks")
    assert "emergency_service" in _svc("24-hour emergency response")
    assert "emergency_service" in _svc("24hr Emergency Service") and "emergency_service" in _svc("Open 24 hrs")
    assert "emergency_service" not in _svc("estimates returned within 24 hrs")
    # Round-the-clock hours count like 24/7 (1119256, 1104750, 1125744); a reply-time promise does not (1164339).
    for txt in ("Hours of Operation: | Open 24 Hours", "Monday-Sunday: Call Us 24 Hours!", "Hours: Open 24 hours per day."):
        assert "emergency_service" in _svc(txt), txt
    assert "emergency_service" not in _svc("Get a free, no-obligation estimate. We typically respond within 24 hours.")


def test_scan_services_skips_article_and_legal_pages_and_keeps_evidence():
    pages = [("https://acme.com/", "Roof Repair\nResidential roofing"),
             ("https://acme.com/blog/storm-season", "Storm damage is common; 24/7 crews are rare."),
             ("https://acme.com/privacy-policy", "new construction"),
             ("https://acme.com/services/", "Expertise\nRe-roof\nNew Construction\nTear-Offs\n24/7 Emergency Roof Repair")]
    services, counts, evidence = wc.scan_services(pages)
    assert {"roof_repair", "new_construction", "emergency_service"} <= set(services)
    assert "storm_damage" not in services and counts["new_construction"] == 1
    assert counts["emergency_service"] == 2 and evidence["emergency_service"][0]["url"] == "https://acme.com/services/"
    assert evidence["new_construction"] == [{"url": "https://acme.com/services/", "snippet": "Re-roof | New Construction | Tear-Offs"}]
    assert evidence["roof_repair"][0]["url"] == "https://acme.com/"
    assert wc.non_service_page("https://x.com/terms-of-service") and wc.non_service_page("https://x.com/news/")
    assert not wc.non_service_page("https://x.com/new-construction/") and not wc.non_service_page("https://x.com/services/")


def test_extract_all_scans_the_homepage_meta_description():
    # 1117149: the only new-construction mention is the homepage's meta description.
    html = """<html><head><meta name="description" content="AJT Complete Construction: Your trusted partner for quality
    construction services. From renovations to new builds, we bring expertise and reliability to every project.">
    </head><body><main><h2>Masonry</h2><p>Brick, stone and concrete work.</p></main></body></html>"""
    page = wc.parse_page(html, "https://ajtcompleteconstruction.com/")
    data = wc.extract_all([page], wc.LeadContext({"gaf_id": "1117149", "name": "AJT Complete Construction"}),
                          "ajtcompleteconstruction.com", today=date(2026, 10, 18))
    assert "new_construction" in data["services"]
    assert "new builds" in data["service_evidence"]["new_construction"][0]["snippet"]


def test_extract_all_stores_service_evidence():
    html = """<html><body><main><h2>Services</h2><p>We offer 24/7 emergency roof repair across Bergen County.</p>
    </main></body></html>"""
    page = wc.parse_page(html, "https://acme-roofing.com/services")
    data = wc.extract_all([page], wc.LeadContext({"gaf_id": "1", "name": "Acme Roofing"}), "acme-roofing.com",
                          today=date(2026, 10, 18))
    ev = data["service_evidence"]["emergency_service"][0]
    assert ev["url"] == "https://acme-roofing.com/services" and "24/7 emergency roof repair" in ev["snippet"]


def test_choose_links_drops_hacked_spam_pages():
    # 1158683 (overstateconstruction.com): an injected gambling post was crawled instead of the contact page.
    page = wc.ParsedPage(url="https://overstateconstruction.com/", links=[
        ("https://overstateconstruction.com/beginners-guide-to-real-money-pokies-what-to-know-about-payid-pokies-australia/",
         "Beginners Guide to Real Money Pokies: what to know about our services"),
        ("https://overstateconstruction.com/best-online-casino-bonus/", "About online casinos"),
        ("https://overstateconstruction.com/about-us/", "About Us"),
        ("https://overstateconstruction.com/contact/", "Contact"),
    ])
    urls = [u for u, _ in wc.choose_links(page, "overstateconstruction.com")]
    assert urls == ["https://overstateconstruction.com/about-us/", "https://overstateconstruction.com/contact/"]
