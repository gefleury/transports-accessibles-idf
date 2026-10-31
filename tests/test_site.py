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

from contextlib import contextmanager
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


@contextmanager
def _site_page(site_url, **page_options):
    """The site, loaded and initialized in a headless Chromium page."""
    with sync_playwright() as playwright:
        # MapLibre needs WebGL; headless Chromium only provides it via
        # software rendering (SwiftShader), which requires this opt-in.
        # Hiding the display variables matters under WSL: SwiftShader
        # fails to initialize when a Wayland display is advertised.
        browser = playwright.chromium.launch(
            args=["--enable-unsafe-swiftshader"],
            env={"WAYLAND_DISPLAY": "", "DISPLAY": ""},
        )
        page = browser.new_page(**page_options)
        page.goto(site_url)
        _wait_for_init(page)
        yield page
        browser.close()


def _wait_for_init(page):
    # The stats line is filled at the very end of initialization, after the
    # tiles metadata and lines.json have been fetched, the sidebar built, and
    # the filters applied.
    page.wait_for_function(
        "document.querySelector('#stats').textContent.includes('affichée')",
        timeout=30_000,
    )


@pytest.fixture
def page(site_url):
    with _site_page(site_url) as page:
        yield page


@pytest.fixture
def touch_page(site_url):
    """A touch screen: taps fire touch events, as on a phone or tablet."""
    with _site_page(site_url, has_touch=True) as page:
        yield page


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
        _wait_for_init(page)
        # One row per transport mode, built from lines.json.
        assert page.locator("#modes .mode").count() == 8
        browser.close()

    assert errors == [], f"JavaScript errors on page load: {errors}"


def test_mode_shows_all_its_lines_until_some_are_picked(page):
    # Transilien starts off: ticking it shows all its lines, picking one
    # line then narrows it to that line.
    transilien = page.locator("#modes .mode", has_text="Transilien")
    before = _line_count(page)

    transilien.locator(".mode-toggle input").check()
    assert _line_count(page) > before + 1

    transilien.locator(".multiselect-box").click()
    transilien.locator(".option").first.click()
    expect(page.locator("#stats")).to_have_text(f"{before + 1} ligne(s) affichée(s)")


def test_line_serves_cities_with_a_matching_stop_in_each(page):
    # A line with an accessible stop in city A, inaccessible ones only in B.
    served = page.evaluate(
        """() => {
          const line = {cities: {A: {true: 1}, B: {false: 2}}};
          const serves = (access, cities) => lineServesCities(line, access, new Set(cities));
          return [
            serves(['true', 'partial'], []),          // no city selected
            serves(['true', 'partial'], ['A']),
            serves(['true', 'partial'], ['A', 'B']),  // no matching stop in B
            serves(['true', 'false'], ['A', 'B']),
            serves(['true', 'partial'], ['C']),       // doesn't go through C
          ];
        }"""
    )
    assert served == [True, True, False, True, False]


def _shown_modes(page) -> dict:
    """Mode → "on", "off", or "empty" (no line matching the filters)."""
    return page.evaluate(
        """() => Object.fromEntries([...document.querySelectorAll('#modes .mode')].map(row => {
          const box = row.querySelector('.mode-toggle input');
          const state = box.disabled ? 'empty' : box.checked ? 'on' : 'off';
          return [row.querySelector('.mode-name').textContent, state];
        }))"""
    )


def _shown_lines_missing_a_city(page, codes) -> list:
    """Shown lines without a stop of the selected accessibility in one of
    these cities (INSEE codes) — should be none."""
    return page.evaluate(
        """(codes) => visibleRouteIds()
          .map(id => LINES.find(l => l.route_id === id))
          .filter(l => !codes.every(c => selectedAccess().some(k => l.cities[c]?.[k])))
          .map(l => l.route_long_name)""",
        codes,
    )


def _add_city(page, query, label):
    """Type a query in the city search box and pick a suggested city."""
    cities = page.locator("#cities")
    cities.locator(".multiselect-input").fill(query)
    cities.get_by_role("button", name=label, exact=True).click()


def _remove_city(page, label):
    page.locator("#cities").get_by_role("button", name=f"Retirer {label}", exact=True).click()


def test_city_filter_shows_every_mode_and_lines_serving_all_cities(page):
    """Selecting a city shows every mode's lines serving it, buses included;
    a second city keeps only the lines serving both; clearing them restores
    the default modes and lines."""
    default_modes, default_count = _shown_modes(page), _line_count(page)
    assert default_modes["Bus"] == "off", "Bus is expected off by default"

    _add_city(page, "paris", "Paris (75)")
    assert "off" not in _shown_modes(page).values(), "Selecting a city should show every mode"
    assert _shown_lines_missing_a_city(page, ["75056"]) == []
    paris_count = _line_count(page)

    _add_city(page, "saint denis", "Saint-Denis (93)")
    both_count = _line_count(page)
    assert 0 < both_count < paris_count
    assert _shown_lines_missing_a_city(page, ["75056", "93066"]) == []
    assert "14" in page.evaluate(
        "visibleRouteIds().map(id => LINES.find(l => l.route_id === id))"
        ".filter(l => l.mode === 'Métro').map(l => l.route_long_name)"
    ), "Metro 14 serves both Paris and Saint-Denis"

    # A line picked from the cities' lists doesn't outlive them.
    bus = page.locator("#modes .mode", has_text="Bus")
    bus.locator(".multiselect-box").click()
    bus.locator(".option").first.click()
    page.keyboard.press("Escape")

    _remove_city(page, "Paris (75)")
    _remove_city(page, "Saint-Denis (93)")
    assert _shown_modes(page) == default_modes
    assert _line_count(page) == default_count
    assert page.evaluate("modeState.Bus.lines.size") == 0, "Clearing the cities should clear line picks"


def test_reset_restores_the_default_view(page):
    """"Réinitialiser" shows once a filter changes, and puts every filter
    back: accessibility, cities, modes, line picks."""
    reset = page.locator("#reset-filters")
    default_modes, default_count = _shown_modes(page), _line_count(page)
    expect(reset).to_be_hidden()

    _add_city(page, "orly", "Orly (94)")
    bus = page.locator("#modes .mode", has_text="Bus")
    bus.locator(".multiselect-box").click()
    bus.locator(".option").first.click()
    page.keyboard.press("Escape")
    partial = page.locator("#access label", has_text="Partiellement").locator("input")
    partial.uncheck()
    expect(reset).to_be_visible()

    reset.click()
    expect(reset).to_be_hidden()
    expect(partial).to_be_checked()
    assert page.locator("#cities .tag").count() == 0
    assert _shown_modes(page) == default_modes
    assert _line_count(page) == default_count
    assert page.evaluate("modeState.Bus.lines.size") == 0
    expect(page.locator("#sidebar")).to_have_attribute("open", ""), "The click mustn't fold the panel"


def test_city_search_matches_word_starts(page):
    search = page.locator("#cities .multiselect-input")

    def found(query):
        search.fill(query)
        return page.locator("#cities .option").all_text_contents()

    # Case and accents ignored, from the start of a word only.
    assert "Créteil (94)" in found("cre")
    assert "Vaucresson (92)" not in found("cre")
    assert "Le Kremlin-Bicêtre (94)" in found("kremlin")
    assert "L'Haÿ-les-Roses (94)" in found("l hay")
    assert "Saint-Maur-des-Fossés (94)" in found("saint maur")
    # Names starting with the query come first.
    assert found("paris")[0] == "Paris (75)"


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


def _wait_for_map_idle(page):
    page.wait_for_function("map.areTilesLoaded() && !map.isMoving()", timeout=60_000)


def test_highlight_does_not_reprocess_tiles(page):
    """Highlighting must only use feature-state and constant paint values
    (site/highlight.js). A filter or data-driven paint change instead makes
    MapLibre reprocess every loaded tile on each selection: the highlight
    lagged, and flickered as the reprocessing briefly emptied the features
    under the cursor.
    """
    _wait_for_map_idle(page)
    tile_loads = page.evaluate(
        """() => new Promise(resolve => {
          // Count tile (re)loads: with the map idle, any is a reprocessing.
          const source = map.getSource('transports');
          const loadTile = source.loadTile.bind(source);
          let loads = 0;
          source.loadTile = (...args) => { loads++; return loadTile(...args); };
          const line = map.queryRenderedFeatures({layers: ['lines']})[0].properties.route_id;
          setHighlight([line], []);
          setHighlight([], []);
          map.triggerRepaint();  // reprocessing starts on the next frame
          setTimeout(() => resolve(loads), 1000);
        })"""
    )
    assert tile_loads == 0, f"Highlighting reloaded {tile_loads} tile(s)"


def _stop_and_empty_spots(page):
    """Page coordinates of a stop, and of a spot with no line or stop, clear
    of the map notice and the "Revenir à la vue d'ensemble" button."""
    _wait_for_map_idle(page)
    return page.evaluate(
        """() => {
          const r = map.getCanvas().getBoundingClientRect();
          const toPage = ([x, y]) => [x + r.left, y + r.top];
          const stop = map.queryRenderedFeatures({layers: ['stops']})[0];
          let empty = null;
          for (let x = 20; x < r.width - 20 && !empty; x += 10)
            for (let y = 80; y < r.height - 80 && !empty; y += 10)
              if (!map.queryRenderedFeatures([x, y], {layers: ['stops', 'lines']}).length) empty = [x, y];
          const p = map.project(stop.geometry.coordinates);
          return {stop: toPage([p.x, p.y]), empty: toPage(empty)};
        }"""
    )


def _selection_state(page):
    return page.evaluate(
        """() => ({
          popup: hoverPopup.isOpen(),
          highlighted: highlighted.lineIds.length > 0,
          button: !document.querySelector('.deselect-button').hidden,
          hint: !document.querySelector('.map-notice').hidden
            && document.querySelector('.map-notice [data-hint="select"]') !== null,
        })"""
    )


# Popup only, with the how-to hint; selection (highlight + "Revenir à la vue
# d'ensemble" button); nothing.
PREVIEW = {"popup": True, "highlighted": False, "button": False, "hint": True}
SELECTED = {"popup": True, "highlighted": True, "button": True, "hint": False}
CLEARED = {"popup": False, "highlighted": False, "button": False, "hint": False}


def test_click_selects_and_hover_only_previews(page):
    """Hover previews a stop's popup without highlighting; a click selects
    it, and hovering elsewhere then leaves the selection alone until the
    "Revenir à la vue d'ensemble" button clears it. The hint stops once the
    user has selected something, until the next visit.
    """
    spots = _stop_and_empty_spots(page)

    page.mouse.move(*spots["stop"])
    assert _selection_state(page) == PREVIEW

    page.mouse.click(*spots["stop"])
    assert _selection_state(page) == SELECTED

    page.mouse.move(*spots["empty"])
    assert _selection_state(page) == SELECTED, "Hovering elsewhere should leave the selection alone"

    page.locator(".deselect-button").click()
    assert _selection_state(page) == CLEARED

    page.mouse.move(*spots["stop"])
    assert _selection_state(page)["hint"] is False, "The hint should be gone once the user has selected"

    page.reload()
    _wait_for_init(page)
    page.mouse.move(*_stop_and_empty_spots(page)["stop"])
    assert _selection_state(page)["hint"] is True, "The hint should be back on a new visit"


def _caught_by_mouse_and_finger(page, find_spot):
    """The layers of what featuresAt() catches, for the mouse and for a
    finger, at the spot returned by find_spot (JS function, null if none)."""
    _wait_for_map_idle(page)
    return page.evaluate(
        f"""() => {{
          const p = ({find_spot})();
          if (!p) return null;
          const caught = touch => {{
            touchInput = touch;
            return featuresAt(p).map(f => f.layer.id);
          }};
          const result = {{mouse: caught(false), finger: caught(true)}};
          touchInput = false;
          return result;
        }}"""
    )


def test_finger_catches_a_stop_or_line_tapped_beside_it(page):
    """A finger is less precise than a mouse: a tap a little beside a stop
    (12 px, on nothing) or a line (6 px, no stop nearby) still catches it; the
    mouse stays exact."""
    beside_stop = _caught_by_mouse_and_finger(
        page,
        """() => {
          for (const stop of map.queryRenderedFeatures({layers: ['stops']}).slice(0, 50)) {
            const c = map.project(stop.geometry.coordinates);
            for (const [dx, dy] of [[12, 0], [-12, 0], [0, 12], [0, -12]]) {
              const p = new maplibregl.Point(c.x + dx, c.y + dy);
              if (!map.queryRenderedFeatures(p, {layers: ['stops', 'lines']}).length) return p;
            }
          }
          return null;
        }""",
    )
    assert beside_stop, "No empty spot found 12 px from a stop"
    assert beside_stop["mouse"] == [], "The mouse should only catch what's exactly under it"
    assert beside_stop["finger"] and set(beside_stop["finger"]) == {"stops"}, \
        "A finger tap 12 px beside a stop should catch it"

    # 6 px off a segment's middle, on nothing, inside the map, no stop within 25 px.
    beside_line = _caught_by_mouse_and_finger(
        page,
        """() => {
          const {clientWidth: w, clientHeight: h} = map.getCanvas();
          const free = p => p.x > 0 && p.x < w && p.y > 0 && p.y < h
            && !map.queryRenderedFeatures(p, {layers: ['stops', 'lines']}).length
            && !map.queryRenderedFeatures([[p.x - 25, p.y - 25], [p.x + 25, p.y + 25]],
                                          {layers: ['stops']}).length;
          for (const line of map.queryRenderedFeatures({layers: ['lines']})) {
            const g = line.geometry;
            const path = g.type === 'LineString' ? g.coordinates : g.coordinates[0];
            for (let i = 1; i < path.length; i++) {
              const a = map.project(path[i - 1]), b = map.project(path[i]);
              const len = Math.hypot(b.x - a.x, b.y - a.y);
              if (len < 20) continue;
              const p = new maplibregl.Point((a.x + b.x) / 2 - 6 * (b.y - a.y) / len,
                                             (a.y + b.y) / 2 + 6 * (b.x - a.x) / len);
              if (free(p)) return p;
            }
          }
          return null;
        }""",
    )
    assert beside_line, "No empty spot found 6 px from a line, away from stops"
    assert beside_line["mouse"] == [], "The mouse should only catch what's exactly under it"
    assert beside_line["finger"] == ["lines"], "A finger tap 6 px beside a line should catch it"


def test_second_tap_selects_only_the_same_stop_point(page):
    """A second tap selects only if aimed at the same stop point: the other
    direction of a bus stop (same name, another stop_id) previews again."""
    _wait_for_map_idle(page)
    keys = page.evaluate(
        """() => {
          const {clientWidth: w, clientHeight: h} = map.getCanvas();
          const byName = new Map();
          for (const f of map.queryRenderedFeatures({layers: ['stops']})) {
            const p = map.project(f.geometry.coordinates);
            if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue;
            const {stop_name, stop_id} = f.properties;
            if (!byName.has(stop_name)) byName.set(stop_name, new Map());
            byName.get(stop_name).set(stop_id, p);
          }
          const key = p => popupSubject(featuresAt(p), p).key;
          for (const points of byName.values()) {
            const [a, b] = [...points.values()];
            if (!b || a.dist(b) < 4) continue;
            // 1 px from a's center, away from b: another spot of the same circle.
            const away = a.add(a.sub(b).unit());
            return {a: key(a), aAgain: key(away), b: key(b)};
          }
          return null;
        }"""
    )
    assert keys, "No stop name with two distinct stop points on screen"
    assert keys["a"] == keys["aAgain"], "Two taps on the same stop point should count as the same"
    assert keys["a"] != keys["b"], "A same-name stop point with another stop_id should not count as the same"


def test_first_tap_previews_and_second_tap_selects(touch_page):
    """A finger can't hover: its first tap on a stop previews it (Street View
    link usable, hint inviting to tap again), a second one selects it, and a
    tap on an empty spot clears it. On iOS, a tap used to fire a mousemove
    that opened the hover popup — and Safari then dropped the click, so it
    took two taps to select, and the Street View link was unusable before.
    """
    spots = _stop_and_empty_spots(touch_page)

    touch_page.touchscreen.tap(*spots["stop"])
    assert _selection_state(touch_page) == PREVIEW

    # Two taps within 500 ms are MapLibre's double-tap zoom.
    touch_page.wait_for_timeout(600)
    touch_page.touchscreen.tap(*spots["stop"])
    assert _selection_state(touch_page) == SELECTED

    touch_page.touchscreen.tap(*spots["empty"])
    assert _selection_state(touch_page) == CLEARED
