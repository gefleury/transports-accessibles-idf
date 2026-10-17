"""External link check for the site's pages and footer.

Collects every external link (href="http...") in the page sources
(site/_pages/, site/_partials/) and requests it. Warns (doesn't fail — the
CI workflow turns this into a GitHub issue) if any is clearly broken, so a
dead link gets fixed without blocking a data update.

Only clear failures count as broken: HTTP 404/410, or a domain that no
longer exists. Anything else (403, 429, 5xx, timeouts) is inconclusive and
ignored: several sites (RATP, Transilien…) refuse automated requests with
403 even though the page exists for a browser.

Skipped when offline. Run with:
    python -m pytest tests/test_links.py
"""

import re
import socket
import urllib.error
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

SITE_DIR = Path(__file__).resolve().parent.parent / "site"
SOURCES = [*SITE_DIR.glob("_pages/*.html"), *SITE_DIR.glob("_partials/*.html")]
BROKEN_STATUSES = {404, 410}


def _online() -> bool:
    try:
        socket.getaddrinfo("data.iledefrance-mobilites.fr", 443)
        return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not _online(), reason="offline — skipping external link check")


def external_links() -> list[str]:
    links = set()
    for path in SOURCES:
        links |= set(re.findall(r'href="(https?://[^"]+)"', path.read_text()))
    return sorted(links)


def broken_reason(url: str) -> str | None:
    """Why the link is clearly broken, or None if it works or can't be told."""
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (link check)"})
    try:
        with urllib.request.urlopen(request, timeout=20):
            return None
    except urllib.error.HTTPError as error:
        return f"HTTP {error.code}" if error.code in BROKEN_STATUSES else None
    except urllib.error.URLError as error:
        return "domain not found" if isinstance(error.reason, socket.gaierror) else None
    except OSError:  # timeouts, connection resets: inconclusive
        return None


def test_external_links_are_not_broken():
    links = external_links()
    assert links, "No external link found — has the page sources' location changed?"
    with ThreadPoolExecutor(max_workers=8) as pool:
        reasons = dict(zip(links, pool.map(broken_reason, links)))
    broken = {url: reason for url, reason in reasons.items() if reason}
    if broken:
        warnings.warn(
            "Broken external link(s) on the site: "
            + ", ".join(f"{url} ({reason})" for url, reason in broken.items())
        )
