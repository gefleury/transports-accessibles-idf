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


def map_mode(series: pd.Series) -> pd.Series:
    mode_map = {
        "Bus": "Bus",
        "CableWay": "Autre",
        "Funicular": "Autre",
        "LocalTrain": "Transilien",
        "Metro": "Métro",
        "RailShuttle": "Navette aéroport",
        "RapidTransit": "RER",
        "Tramway": "Tramway",
        "regionalRail": "TER",
    }
    return series.map(mode_map)


def prepare_lines(
    gdf_lines: gpd.GeoDataFrame, gdf_stops: gpd.GeoDataFrame
) -> gpd.GeoDataFrame:
    mode_per_route = gdf_stops[["id", "mode"]].drop_duplicates("id")
    out_gdf = (
        gdf_lines[
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
        ]
        .copy()
        # Drop SNCF-operated bus lines (are they errors in the input data?)
        .loc[lambda df: ~((df["route_type"] == "Bus") & (df["operatorname"] == "SNCF"))]
        # Normalise route_color: source has no '#' prefix
        .assign(
            route_color=lambda df: df["route_color"].apply(
                lambda c: f"#{c}" if pd.notna(c) and not str(c).startswith("#") else c
            )
        )
        # Add normalised mode from stops (one value per route_id)
        .merge(mode_per_route, left_on="route_id", right_on="id", how="left")
        .drop(columns=["id"])
        .assign(mode=lambda df: map_mode(df["mode"]))
    )
    return out_gdf


def prepare_stops(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    return gdf[
        [
            "id",
            "stop_id",
            "stop_name",
            "shortname",
            "nom_commune",
            "code_insee",
            "geometry",
        ]
    ].copy()


def prepare_accessibility_bus(
    df: pd.DataFrame, gdf_stops: gpd.GeoDataFrame
) -> pd.DataFrame:
    """Clean the bus stop accessibility file (sdap-arrets-associes.csv).

    Joins with gdf_stops on (stop_id, route_id) to get route_long_name —
    the API no longer provides route_long_name directly (column was renamed
    to arraccessibility / route_id vs the old ArRAccessibility / route_long_name).
    Returns one row per (stop_id, route_long_name) pair with ArRAccessibility.
    """
    bus_stop_lines = gdf_stops[gdf_stops["mode"] == "Bus"][
        ["stop_id", "id", "route_long_name"]
    ].drop_duplicates()
    return (
        df[["stop_id", "route_id", "arraccessibility"]]
        .drop_duplicates(subset=["stop_id", "route_id"])
        .rename(columns={"arraccessibility": "ArRAccessibility"})
        .fillna({"ArRAccessibility": "unknown"})
        .merge(
            bus_stop_lines,
            left_on=["stop_id", "route_id"],
            right_on=["stop_id", "id"],
            how="inner",
        )[["stop_id", "route_long_name", "ArRAccessibility"]]
        .drop_duplicates(subset=["stop_id", "route_long_name"])
        .reset_index(drop=True)
    )


def prepare_accessibility_tramway(gdf_stops: gpd.GeoDataFrame) -> pd.DataFrame:
    """Mark all tramway stops as accessible.

    Tramway lines in Île-de-France are fully accessible by design (low-floor
    vehicles, level boarding). Returns one row per unique (stop_id,
    route_long_name) pair with ArRAccessibility = "true".
    """
    return (
        gdf_stops[gdf_stops["mode"] == "Tramway"][["stop_id", "route_long_name"]]
        .drop_duplicates()
        .assign(ArRAccessibility="true")
        .reset_index(drop=True)
    )


def prepare_accessibility_metro(gdf_stops: gpd.GeoDataFrame) -> pd.DataFrame:
    """Assign wheelchair accessibility to metro stops.

    Rules:
    - Line 14 (≥ 14): all stops accessible ("true").
    - Line 11: a fixed set of newly-built stations are accessible ("true"),
      the rest are not ("false").
    - All other metro lines: "false".
    Returns one row per (stop_id, route_long_name) pair, so a stop shared
    between line 11 and line 14 gets the correct status for each line.
    """
    # route_long_name holds the line number (e.g. "11", "14"); stop_name is the station name
    line_11_accessible = {
        "Porte des Lilas",
        "Mairie des Lilas",
        "Serge Gainsbourg",
        "Romainville - Carnot",
        "Montreuil - Hôpital",
        "La Dhuys",
        "Coteaux Beauclair",
        "Rosny-Bois-Perrier",
    }

    def get_status(row) -> str:
        line = row["route_long_name"]
        try:
            if int(line) >= 14:
                return "true"
        except (ValueError, TypeError):
            pass
        if line == "11" and row["stop_name"] in line_11_accessible:
            return "true"
        return "false"

    out = (
        gdf_stops[gdf_stops["mode"] == "Metro"][
            ["stop_id", "route_long_name", "stop_name"]
        ]
        .drop_duplicates(subset=["stop_id", "route_long_name"])
        .assign(ArRAccessibility=lambda df: df.apply(get_status, axis=1))[
            ["stop_id", "route_long_name", "ArRAccessibility"]
        ]
        .reset_index(drop=True)
    )
    return out


def prepare_accessibility_train(
    df: pd.DataFrame, gdf_stops: gpd.GeoDataFrame
) -> pd.DataFrame:
    """Clean the train/RER station accessibility file.

    - Strips the "stop_point:" prefix from stop_point_id and renames it stop_id.
    - Maps accessibility_level_id to the shared vocabulary:
        6 → true, 3/4 → partial, 1 → false, NaN → unknown.
    - Merges with gdf_stops to get one row per (stop_id, route_long_name) pair.
    """
    accessibility_map = {1: "false", 3: "partial", 4: "partial", 6: "true"}
    train_modes = {"LocalTrain", "RapidTransit", "regionalRail"}

    accessibility = df[["stop_point_id", "accessibility_level_id"]].copy()
    accessibility["stop_id"] = accessibility["stop_point_id"].str.replace(
        "stop_point:", "", regex=False
    )
    accessibility["ArRAccessibility"] = (
        accessibility["accessibility_level_id"].map(accessibility_map).fillna("unknown")
    )
    accessibility = accessibility[["stop_id", "ArRAccessibility"]]

    train_stop_lines = gdf_stops[gdf_stops["mode"].isin(train_modes)][
        ["stop_id", "route_long_name"]
    ].drop_duplicates()
    return (
        train_stop_lines.merge(accessibility, on="stop_id", how="left")
        .fillna({"ArRAccessibility": "unknown"})
        .reset_index(drop=True)
    )


def join_stops_to_lines(
    lines: gpd.GeoDataFrame, stops: gpd.GeoDataFrame
) -> gpd.GeoDataFrame:
    """Left-join stops onto lines metadata.

    Lines is the left table, so only stops that match a known route_id are
    kept — orphan stops are discarded automatically.
    """
    lines_meta = lines.drop(columns=["geometry"]).drop_duplicates(subset="route_id")[
        [
            "route_id",
            "route_type",
            "route_short_name",
            "route_long_name",
            "route_color",
            "mode",
        ]
    ]
    enriched = (
        lines_meta.merge(stops, left_on="route_id", right_on="id", how="left")
        .drop(columns=["route_id"])
        .dropna(subset=["mode"])
    )
    return gpd.GeoDataFrame(enriched, geometry="geometry", crs=stops.crs)


def join_accessibility(
    stops: gpd.GeoDataFrame,
    *accessibility_dfs: pd.DataFrame,
) -> gpd.GeoDataFrame:
    """Left-join accessibility status onto stops by (stop_id, route_long_name).

    Accepts any number of accessibility DataFrames (each with stop_id,
    route_long_name, and ArRAccessibility columns). They are concatenated in
    order, with later tables taking precedence over earlier ones for duplicate
    (stop_id, route_long_name) pairs.
    Stops with no match get "unknown" in ArRAccessibility.
    """
    combined = pd.concat(accessibility_dfs, ignore_index=True)
    combined = combined.drop_duplicates(
        subset=["stop_id", "route_long_name"], keep="last"
    )
    enriched = stops.merge(combined, on=["stop_id", "route_long_name"], how="left")
    enriched["ArRAccessibility"] = enriched["ArRAccessibility"].fillna("unknown")
    return gpd.GeoDataFrame(enriched, geometry="geometry", crs=stops.crs)


def join_line_accessibility(
    lines: gpd.GeoDataFrame,
    stops: gpd.GeoDataFrame,
) -> gpd.GeoDataFrame:
    """Add per-line accessibility summary flags to lines.

    For each route, computes whether it has at least one stop for each
    accessibility status (has_accessible, has_partial, has_inaccessible,
    has_unknown), then left-joins onto lines.
    Must be called after join_accessibility so stops already have ArRAccessibility.
    """
    status_cols = {
        "true": "has_accessible",
        "partial": "has_partial",
        "false": "has_inaccessible",
        "unknown": "has_unknown",
    }
    # One set of accessibility values per route (stops["id"] == lines route_id)
    summary = stops.groupby("id")["ArRAccessibility"].apply(set).reset_index()
    for status, col in status_cols.items():
        summary[col] = summary["ArRAccessibility"].apply(lambda s, v=status: v in s)
    summary = summary.drop(columns=["ArRAccessibility"])

    enriched = lines.merge(summary, left_on="route_id", right_on="id", how="left")
    enriched = enriched.drop(columns=["id"])
    for col in status_cols.values():
        enriched[col] = enriched[col].fillna(False).astype(bool)
    return gpd.GeoDataFrame(enriched, geometry="geometry", crs=lines.crs)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Loading raw data...")
    gdf_lines = gpd.read_file(RAW_LINES)
    gdf_stops = gpd.read_file(RAW_STOPS)
    df_accessibility_bus = pd.read_csv(RAW_ACCESSIBILITY_BUS, sep=";")
    df_accessibility_train = pd.read_csv(RAW_ACCESSIBILITY_TRAIN, sep=";")

    print("Preparing stops...")
    accessibility_bus = prepare_accessibility_bus(df_accessibility_bus, gdf_stops)
    accessibility_tramway = prepare_accessibility_tramway(gdf_stops)
    accessibility_metro = prepare_accessibility_metro(gdf_stops)
    accessibility_train = prepare_accessibility_train(df_accessibility_train, gdf_stops)
    lines = prepare_lines(gdf_lines, gdf_stops)
    stops = prepare_stops(gdf_stops)
    stops = join_stops_to_lines(lines, stops)
    # Precedence: bus < tramway < metro < train (last wins on duplicate stop_id)
    stops = join_accessibility(
        stops,
        accessibility_bus,
        accessibility_tramway,
        accessibility_metro,
        accessibility_train,
    )
    stops.to_file(OUT_STOPS, driver="GeoJSON")
    print(f"  Written {len(stops)} stops → {OUT_STOPS}")

    print("Preparing lines...")
    lines = join_line_accessibility(lines, stops)
    lines.to_file(OUT_LINES, driver="GeoJSON")
    print(f"  Written {len(lines)} lines → {OUT_LINES}")


if __name__ == "__main__":
    main()
