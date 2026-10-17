"""Browser smoke test for the static web app in site/.

Serves site/ on a local HTTP server (with the Range support PMTiles
requires) and loads the page in a headless Chromium via Playwright, then
checks that initialization completes without JavaScript errors. Catches
frontend regressions invisible to the Python test suite — e.g. a sidebar
crash that silently prevents filters from ever being applied.

Skipped automatically when the site data files are missing (run
src/build_tiles.py first) or the browser dependencies are not installed
(pip install --group ci && playwright install chromium).

Run with:
    python -m pytest tests/test_site.py
"""

from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

SITE_DIR = Path(__file__).resolve().parent.parent / "site"

SITE_DATA_AVAILABLE = (
    (SITE_DIR / "data" / "transports.pmtiles").exists()
    and (SITE_DIR / "data" / "lines.json").exists()
)

try:
    from playwright.sync_api import expect, sync_playwright
    from RangeHTTPServer import RangeRequestHandler

    BROWSER_DEPS_AVAILABLE = True
except ImportError:
    BROWSER_DEPS_AVAILABLE = False

pytestmark = [
    pytest.mark.skipif(
        not SITE_DATA_AVAILABLE, reason="site/data/ files missing — run src/build_tiles.py first"
    ),
    pytest.mark.skipif(
        not BROWSER_DEPS_AVAILABLE, reason="playwright/rangehttpserver not installed — skipping"
    ),
]


@pytest.fixture(scope="module")
def site_url():
    handler = partial(RangeRequestHandler, directory=str(SITE_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/"
    server.shutdown()


@pytest.fixture
def page(site_url):
    with sync_playwright() as playwright:
        # MapLibre needs WebGL; headless Chromium only provides it via
        # software rendering (SwiftShader), which requires this opt-in.
        # Hiding the display variables matters under WSL: SwiftShader
        # fails to initialize when a Wayland display is advertised.
        browser = playwright.chromium.launch(
            args=["--enable-unsafe-swiftshader"],
            env={"WAYLAND_DISPLAY": "", "DISPLAY": ""},
        )
        page = browser.new_page()
        page.goto(site_url)
        # The stats line is filled at the very end of initialization, after
        # the tiles metadata and lines.json have been fetched, the sidebar
        # built, and the filters applied.
        page.wait_for_function(
            "document.querySelector('#stats').textContent.includes('affichée')",
            timeout=30_000,
        )
        yield page
        browser.close()


def _line_count(page) -> int:
    text = page.locator("#stats").text_content()
    return int(text.split(" ", 1)[0])


def test_page_initializes_without_js_errors(site_url):
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            args=["--enable-unsafe-swiftshader"],
            env={"WAYLAND_DISPLAY": "", "DISPLAY": ""},
        )
        page = browser.new_page()
        page.on(
            "console",
            lambda msg: errors.append(msg.text) if msg.type == "error" else None,
        )
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        page.goto(site_url)
        page.wait_for_function(
            "document.querySelector('#stats').textContent.includes('affichée')",
            timeout=30_000,
        )
        # One expander per transport mode, built from lines.json.
        assert page.locator("#modes details").count() == 8
        browser.close()

    assert errors == [], f"JavaScript errors on page load: {errors}"


def test_selecting_line_shows_it_for_a_mode_disabled_by_default(page):
    # Regression test: visibleRouteIds() used to gate visibility on
    # "toutes les lignes" alone for non-Bus modes, silently ignoring any
    # line selection — so picking a specific line on a mode that starts
    # unchecked (e.g. Transilien) rendered nothing at all on the map.
    transilien = page.locator("#modes details", has_text="Transilien")
    transilien.locator("summary").click()
    all_box = transilien.locator("label", has_text="Afficher toutes les lignes").locator("input")
    expect(all_box).not_to_be_checked()

    before = _line_count(page)
    transilien.locator(".dropdown-toggle").last.click()
    transilien.locator(".options label").first.locator("input").check()

    expect(page.locator("#stats")).to_have_text(f"{before + 1} ligne(s) affichée(s)")
    expect(all_box).not_to_be_checked()


def _stop_popup(page, stops, cursor):
    """Render the stop popup for synthetic stop points, without the map.

    Each stop is (stop_name, stop_id, lat, lng) or, for a station with an
    entrance, (stop_name, stop_id, lat, lng, entrance_lat, entrance_lng).
    The cursor is a (lat, lng). Returns, per stop name heading: its Street
    View link's "lat,lng" (None if no link), and whether it shows the
    greyed-out "Zoomez" chip instead.
    """
    return page.evaluate(
        """([stops, cursor]) => {
          const features = stops.map(([name, id, lat, lng, eLat, eLng]) => ({
            properties: {stop_name: name, stop_id: id, mode: 'Bus', route_long_name: '1',
                         ArRAccessibility: 'true', streetview_lat: eLat ?? null, streetview_lng: eLng ?? null},
            geometry: {coordinates: [lng, lat]},
          }));
          const div = document.createElement('div');
          div.innerHTML = stopPopupHtml(features, map.project([cursor[1], cursor[0]]));
          return [...div.querySelectorAll('.stop-title')].map(t => ({
            link: t.querySelector('a.streetview-link')?.href.match(/viewpoint=([^&]+)/)[1] ?? null,
            zoomHint: t.querySelector('.streetview-link.is-disabled') !== null
              && t.textContent.includes('Zoomez'),
          }));
        }""",
        [stops, cursor],
    )


def test_streetview_link_policy(page):
    # 1e-4° of latitude ≈ 11 m.
    lat, lng = 48.86, 2.35

    # A single stop point (reported twice, as across a tile boundary): link
    # at the point itself.
    single = _stop_popup(page, [("A", "a1", lat, lng), ("A", "a1", lat, lng)], (lat, lng))
    assert single == [{"link": f"{lat:.6f},{lng:.6f}", "zoomHint": False}]

    # Two points ~18 m apart (e.g. facing tram platforms, Porte d'Ivry): one
    # link, at the point nearest the cursor — never at the cursor itself.
    north = lat + 1.6e-4
    close = _stop_popup(page, [("B", "b1", lat, lng), ("B", "b2", north, lng)], (north + 1e-5, lng))
    assert close == [{"link": f"{north:.6f},{lng:.6f}", "zoomHint": False}]

    # Two points ~22 m apart (e.g. a bus stop's two directions, Cottages):
    # no link, a greyed-out chip asking to zoom in instead.
    far = _stop_popup(page, [("C", "c1", lat, lng), ("C", "c2", lat + 2.0e-4, lng)], (lat, lng))
    assert far == [{"link": None, "zoomHint": True}]

    # A station with an entrance (e.g. RER B Cité Universitaire): link at
    # the entrance, not at the platforms; the rule applies per heading.
    entrance = (lat + 1e-3, lng + 1e-3)
    mixed = _stop_popup(
        page, [("D", "d1", lat, lng, *entrance), ("C", "c1", lat, lng), ("C", "c2", lat + 2.0e-4, lng)], (lat, lng)
    )
    assert mixed == [
        {"link": f"{entrance[0]:.6f},{entrance[1]:.6f}", "zoomHint": False},
        {"link": None, "zoomHint": True},
    ]


def test_stop_popup_lists_each_line_once_with_all_accessibility_statuses(page):
    """Several stop points with the same name, mode and line (a line's two
    directions or platforms, caught together at low zoom) must share one
    row, listing every distinct accessibility status (accessible, partial…)
    with a note when they differ. The popup used to keep only the first
    status found, hiding e.g. one direction's status at Cottages (bus 1).

    Reads the popup's data-* attributes, not its text, so rewording or
    reordering the popup doesn't break the test.
    """
    stops = [
        # (stop_name, stop_id, mode, line, accessibility status)
        ("Cottages", "c1", "Bus", "1", "partial"),
        ("Cottages", "c2", "Bus", "1", "false"),
        ("Châtelet", "m1", "Métro", "14", "true"),
        ("Châtelet", "m2", "Métro", "14", "true"),
    ]
    headings = page.evaluate(
        """(stops) => {
          const c = map.getCenter();
          const features = stops.map(([name, id, mode, line, status]) => ({
            properties: {stop_name: name, stop_id: id, mode, route_long_name: line, ArRAccessibility: status},
            geometry: {coordinates: [c.lng, c.lat]},
          }));
          hoverPopup.setLngLat(c).setHTML(stopPopupHtml(features, map.project(c))).addTo(map);
          const popup = document.querySelector('.maplibregl-popup-content');
          return {
            rows: [...popup.querySelectorAll('[data-line]')].map(row => ({
              statuses: [...row.querySelectorAll('[data-accessibility]')].map(b => b.dataset.accessibility).sort(),
              hasNote: row.querySelector('.status-note') !== null,
            })),
            focused: document.activeElement.tagName,
          };
        }""",
        stops,
    )
    cottages, chatelet = headings["rows"]
    assert cottages == {"statuses": ["false", "partial"], "hasNote": True}
    assert chatelet == {"statuses": ["true"], "hasNote": False}

    # Regression: MapLibre focuses a popup's first link when it opens
    # (focusAfterOpen), which showed the Street View chip in its focus style.
    assert headings["focused"] == "BODY", "Opening the popup should not move the focus"


def test_show_all_checkbox_syncs_with_line_selection(page):
    # "Afficher toutes les lignes" must never stay checked once it no longer
    # reflects reality, and re-checking it must restore the literal "all"
    # state rather than leaving a stale narrower selection in effect.
    tramway = page.locator("#modes details", has_text="Tramway")
    all_box = tramway.locator("label", has_text="Afficher toutes les lignes").locator("input")
    expect(all_box).to_be_checked()

    lines_toggle = tramway.locator(".dropdown-toggle").last
    lines_toggle.click()
    tramway.locator(".options label").first.locator("input").check()

    expect(all_box).not_to_be_checked()
    expect(lines_toggle).not_to_have_text("Sélectionner…")

    all_box.check()

    expect(lines_toggle).to_have_text("Sélectionner…")
