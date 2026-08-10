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
