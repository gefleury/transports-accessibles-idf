"""Assemble site/*.html from site/_pages/*.html + site/_partials/*.html.

site/_pages/ holds one template per page, each with a single-line marker
(<!--HEADER-->, <!--HEADER_HOME-->, <!--FOOTER-->) where the shared
header/footer from site/_partials/ gets spliced in — the header/footer are
otherwise identical across pages so hand-editing them once per page risked
the copies drifting apart. HEADER_HOME is the homepage's header variant
(no "Accueil" link, since it would just link to itself).

Run from the repo root:

    python src/build_site.py
"""

from pathlib import Path

PAGES_DIR = Path("site/_pages")
PARTIALS_DIR = Path("site/_partials")
OUT_DIR = Path("site")


def build_site():
    footer = (PARTIALS_DIR / "footer.html").read_text()
    accueil = (PARTIALS_DIR / "accueil-link.html").read_text()
    header_template = (PARTIALS_DIR / "header.html").read_text()
    header = header_template.replace("<!--ACCUEIL-->", accueil)
    header_home = header_template.replace("<!--ACCUEIL-->", "")

    for page in PAGES_DIR.glob("*.html"):
        html = (
            page.read_text()
            .replace("<!--HEADER_HOME-->", header_home)
            .replace("<!--HEADER-->", header)
            .replace("<!--FOOTER-->", footer)
        )
        (OUT_DIR / page.name).write_text(html)


if __name__ == "__main__":
    build_site()
