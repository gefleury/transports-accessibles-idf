"""Build site/data/ web assets from data/processed/*.geojson.

Packaging step of the pipeline:
- transports.pmtiles — vector tiles (layers `lines` and `stops`) served
  statically to the map;
- lines.json — one record per transport line (name, mode, operator,
  accessibility flags), used by the sidebar to build the filter widgets.

Requires tippecanoe (https://github.com/felt/tippecanoe).
Run from the repo root:

    python src/build_tiles.py
"""

import json
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

LINES_SRC = Path("data/processed/lines.geojson")
STOPS_SRC = Path("data/processed/stops.geojson")
OUT_PATH = Path("site/data/transports.pmtiles")
LINES_JSON_PATH = Path("site/data/lines.json")

# Per-line attributes exposed to the sidebar in lines.json.
LINES_JSON_ATTRIBUTES = [
    "route_id",
    "route_long_name",
    "mode",
    "operatorname",
    "has_accessible",
    "has_partial",
    "has_inaccessible",
    "has_unknown",
]

# Zoom range of the generated tiles. Below MIN_ZOOM the map shows only the
# basemap; above MAX_ZOOM MapLibre reuses the last tiles (overzooming), so
# 13 is enough detail while keeping the file small.
MIN_ZOOM_LINES = 5
MAX_ZOOM = 13
# Every stop is kept from this zoom up (-r1, no thinning) and the frontend
# hides the stops layer below it: stops are either all shown or all hidden,
# never a zoom-dependent subset. 9 is the lowest zoom where full tiles still
# fit tippecanoe's 500 kB tile-size limit (the build fails loudly otherwise).
MIN_ZOOM_STOPS = 9

# Attributes kept in the tiles — everything else is dropped to keep them small.
LINES_ATTRIBUTES = [
    "route_id",
    "route_short_name",
    "route_long_name",
    "mode",
    "operatorname",
    "route_color",
    "has_accessible",
    "has_partial",
    "has_inaccessible",
    "has_unknown",
]
STOPS_ATTRIBUTES = [
    "stop_id",
    "stop_name",
    "id",
    "route_long_name",
    "mode",
    "ArRAccessibility",
    "nom_commune",
]

# One tiling specification per tile layer.
# - lines: thin dense areas out at low zooms if a tile would exceed the size
#   limit (geometry is simplified per zoom anyway);
# - stops: -r1 disables tippecanoe's default point thinning at low zooms, so
#   the browser can show all stops or none, never a zoom-dependent subset.
LAYERS = [
    {
        "src": LINES_SRC,
        "layer": "lines",
        "min_zoom": MIN_ZOOM_LINES,
        "attributes": LINES_ATTRIBUTES,
        "extra": ["--drop-densest-as-needed"],
    },
    {
        "src": STOPS_SRC,
        "layer": "stops",
        "min_zoom": MIN_ZOOM_STOPS,
        "attributes": STOPS_ATTRIBUTES,
        "extra": ["-r1"],
    },
]


def find_tool(name: str) -> str:
    """Locate a tippecanoe executable on PATH or in ~/.local/bin."""
    found = shutil.which(name)
    if found:
        return found
    local = Path.home() / ".local" / "bin" / name
    if local.is_file():
        return str(local)
    sys.exit(f"error: {name} not found (PATH or ~/.local/bin) — see README")


def run(cmd: list[str]) -> None:
    """Echo then execute a command, failing loudly on a non-zero exit."""
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True)


def build_layer(tippecanoe: str, spec: dict, out: Path) -> None:
    """Tile one GeoJSON source into a single-layer PMTiles file."""
    run(
        [
            tippecanoe,
            "-o",
            str(out),
            "--force",
            f"--layer={spec['layer']}",
            f"--minimum-zoom={spec['min_zoom']}",
            f"--maximum-zoom={MAX_ZOOM}",
            *spec["extra"],
            *[f"--include={attr}" for attr in spec["attributes"]],
            str(spec["src"]),
        ]
    )


def write_lines_json(src: Path, out: Path) -> None:
    """Extract one sidebar record per line from the lines GeoJSON.

    Lines with a null geometry cannot be drawn (tippecanoe skips them too),
    so they are excluded to keep the sidebar consistent with the map.

    `updated_on` is the modification date of the processed file, i.e. the
    last run of prepare_data.py — which in CI is also the download date of
    the raw data. The frontend shows it as the data-freshness date.
    """
    with src.open() as f:
        features = json.load(f)["features"]
    records = [
        {attr: feat["properties"].get(attr) for attr in LINES_JSON_ATTRIBUTES}
        for feat in features
        if feat["geometry"] is not None
    ]
    payload = {
        "updated_on": date.fromtimestamp(src.stat().st_mtime).isoformat(),
        "lines": records,
    }
    with out.open("w") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {out} ({len(records)} lines, {out.stat().st_size / 1e3:.0f} kB)")


def main() -> None:
    """Build all site/data/ web assets from the processed GeoJSON files."""
    tippecanoe = find_tool("tippecanoe")
    tile_join = find_tool("tile-join")

    for src in (LINES_SRC, STOPS_SRC):
        if not src.is_file():
            sys.exit(f"error: {src} not found — run src/prepare_data.py first")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        for spec in LAYERS:
            build_layer(tippecanoe, spec, tmp / f"{spec['layer']}.pmtiles")
        # Merge both layers into the single file served to the browser.
        # Each input already respects tippecanoe's per-tile size limit;
        # without --no-tile-size-limit, tile-join silently DROPS merged
        # tiles exceeding it (dense Paris tiles), leaving holes in the map.
        run(
            [
                tile_join,
                "-o",
                str(OUT_PATH),
                "--force",
                "--no-tile-size-limit",
                *[str(tmp / f"{spec['layer']}.pmtiles") for spec in LAYERS],
            ]
        )

    size_mb = OUT_PATH.stat().st_size / 1e6
    print(f"wrote {OUT_PATH} ({size_mb:.1f} MB)")

    write_lines_json(LINES_SRC, LINES_JSON_PATH)


if __name__ == "__main__":
    main()
