"""Assemble site/*.html from site/_pages/*.html + site/_partials/*.html.

site/_pages/ holds one template per page, each with single-line markers
(<!--HEADER-->, <!--HEADER_HOME-->, <!--FOOTER-->) where the shared
header/footer from site/_partials/ gets spliced in — this markup is
otherwise identical across pages so hand-editing it once per page risked
the copies drifting apart. HEADER_HOME is the homepage's header variant
(no "Accueil" link, since it would just link to itself).

The header/footer reference icons (nav chevron, hamburger, GitHub mark...)
via <use href="#icon-name">, resolved against the shared <symbol> defs in
site/_partials/icons.html. Every page includes the header, so icons is
prepended to it here rather than left for each page to remember.

Run from the repo root:

    python src/build_site.py
"""

from pathlib import Path

PAGES_DIR = Path("site/_pages")
PARTIALS_DIR = Path("site/_partials")
OUT_DIR = Path("site")


def build_site():
    footer = (PARTIALS_DIR / "footer.html").read_text()
    home_link = (PARTIALS_DIR / "home-link.html").read_text()
    icons = (PARTIALS_DIR / "icons.html").read_text()
    header_template = icons + (PARTIALS_DIR / "header.html").read_text()
    header = header_template.replace("<!--ACCUEIL-->", home_link)
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
