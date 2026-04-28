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
RAW_ACCESSIBILITY_BUS = Path("data/sdap-arrets-associes.csv")
RAW_ACCESSIBILITY_TRAIN = Path("data/accessibilite-en-gare.csv")
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


def prepare_accessibility_bus(df: pd.DataFrame) -> pd.DataFrame:
    """Clean the bus stop accessibility file (sdap-arrets-associes.csv).

    ArRAccessibility is consistent across routes for a given stop_id, so we
    deduplicate on stop_id and keep only the columns needed downstream.
    NaN values are replaced with "unknown".
    """
    return (
        df[["stop_id", "ArRAccessibility"]]
        .drop_duplicates(subset="stop_id")
        .fillna({"ArRAccessibility": "unknown"})
        .reset_index(drop=True)
    )


def prepare_accessibility_train(df: pd.DataFrame) -> pd.DataFrame:
    """Clean the train/RER station accessibility file.

    - Keeps only stop_id and ArRAccessibility.
    - Strips the "stop_point:" prefix from stop_point_id and renames it stop_id.
    - Maps accessibility_level_id to the shared vocabulary:
        6 → true, 3/4 → partial, 1 → false, NaN → unknown.
    """
    accessibility_map = {1: "false", 3: "partial", 4: "partial", 6: "true"}

    out = df[["stop_point_id", "accessibility_level_id"]].copy()
    out["stop_id"] = out["stop_point_id"].str.replace("stop_point:", "", regex=False)
    out["ArRAccessibility"] = (
        out["accessibility_level_id"].map(accessibility_map).fillna("unknown")
    )
    return out[["stop_id", "ArRAccessibility"]].reset_index(drop=True)


def join_stops_to_lines(
    lines: gpd.GeoDataFrame, stops: gpd.GeoDataFrame
) -> gpd.GeoDataFrame:
    """Left-join stops onto lines metadata.

    Lines is the left table, so only stops that match a known route_id are
    kept — orphan stops are discarded automatically.
    """
    lines_meta = lines.drop(columns=["geometry"]).drop_duplicates(subset="route_id")[
        ["route_id", "route_type", "route_short_name", "route_color"]
    ]
    enriched = lines_meta.merge(stops, left_on="route_id", right_on="id", how="left")
    enriched = enriched.drop(columns=["route_id"])
    return gpd.GeoDataFrame(enriched, geometry="geometry", crs=stops.crs)


def join_accessibility(
    stops: gpd.GeoDataFrame,
    accessibility_bus: pd.DataFrame,
    accessibility_train: pd.DataFrame,
) -> gpd.GeoDataFrame:
    """Left-join accessibility status onto stops by stop_id.

    Bus and train accessibility tables are combined first (train takes
    precedence for any stop_id present in both). Stops with no match
    get "unknown" in ArRAccessibility.
    """
    combined = pd.concat([accessibility_bus, accessibility_train], ignore_index=True)
    combined = combined.drop_duplicates(subset="stop_id", keep="last")
    enriched = stops.merge(combined, on="stop_id", how="left")
    enriched["ArRAccessibility"] = enriched["ArRAccessibility"].fillna("unknown")
    return gpd.GeoDataFrame(enriched, geometry="geometry", crs=stops.crs)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Loading raw data...")
    gdf_lines = gpd.read_file(RAW_LINES)
    gdf_stops = gpd.read_file(RAW_STOPS)
    df_accessibility_bus = pd.read_csv(RAW_ACCESSIBILITY_BUS, sep=";")
    df_accessibility_train = pd.read_csv(RAW_ACCESSIBILITY_TRAIN, sep=";")

    print("Preparing lines...")
    lines = prepare_lines(gdf_lines)
    lines.to_file(OUT_LINES, driver="GeoJSON")
    print(f"  Written {len(lines)} lines → {OUT_LINES}")

    print("Preparing stops...")
    accessibility_bus = prepare_accessibility_bus(df_accessibility_bus)
    accessibility_train = prepare_accessibility_train(df_accessibility_train)
    stops = prepare_stops(gdf_stops)
    stops = join_stops_to_lines(lines, stops)
    stops = join_accessibility(stops, accessibility_bus, accessibility_train)
    stops.to_file(OUT_STOPS, driver="GeoJSON")
    print(f"  Written {len(stops)} stops → {OUT_STOPS}")


if __name__ == "__main__":
    main()
