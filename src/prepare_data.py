"""
One-shot data preparation script.

Reads raw source files from data/ and writes cleaned, joined outputs to
data/processed/. Re-run whenever the source files are updated.

Usage:
    python src/prepare_data.py
"""

from pathlib import Path

import geopandas as gpd
import pandas as pd

RAW_LINES = Path("data/traces-des-lignes-de-transport-en-commun-idfm.geojson")
RAW_STOPS = Path("data/arrets-lignes.geojson")
OUT_DIR = Path("data/processed")

OUT_LINES = OUT_DIR / "lines.geojson"
OUT_STOPS = OUT_DIR / "stops.geojson"


def prepare_lines(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    out = gdf[
        [
            "route_id",
            "route_short_name",
            "route_long_name",
            "route_type",
            "route_color",
            "operatorname",
            "networkname",
            "geometry",
        ]
    ].copy()
    # Normalise route_color: source has no '#' prefix
    out["route_color"] = out["route_color"].apply(
        lambda c: f"#{c}" if pd.notna(c) and not str(c).startswith("#") else c
    )
    return out


def prepare_stops(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    return gdf[
        [
            "id",
            "stop_id",
            "stop_name",
            "shortname",
            "mode",
            "nom_commune",
            "code_insee",
            "operatorname",
            "geometry",
        ]
    ].copy()


def join_stops_to_lines(
    lines: gpd.GeoDataFrame, stops: gpd.GeoDataFrame
) -> gpd.GeoDataFrame:
    """Left-join stops onto lines metadata.

    Lines is the left table, so only stops that match a known route_id are
    kept — orphan stops are discarded automatically.
    """
    lines_meta = (
        lines.drop(columns=["geometry"])
        .drop_duplicates(subset="route_id")
        [["route_id", "route_type", "route_short_name", "route_color"]]
    )
    enriched = lines_meta.merge(
        stops, left_on="route_id", right_on="id", how="left"
    )
    enriched = enriched.drop(columns=["route_id"])
    return gpd.GeoDataFrame(enriched, geometry="geometry", crs=stops.crs)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Loading raw data...")
    gdf_lines = gpd.read_file(RAW_LINES)
    gdf_stops = gpd.read_file(RAW_STOPS)

    print("Preparing lines...")
    lines = prepare_lines(gdf_lines)
    lines.to_file(OUT_LINES, driver="GeoJSON")
    print(f"  Written {len(lines)} lines → {OUT_LINES}")

    print("Preparing stops...")
    stops = prepare_stops(gdf_stops)
    stops = join_stops_to_lines(lines, stops)
    stops.to_file(OUT_STOPS, driver="GeoJSON")
    print(f"  Written {len(stops)} stops → {OUT_STOPS}")


if __name__ == "__main__":
    main()
