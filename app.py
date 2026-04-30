import sys

sys.path.insert(0, "src")

import geopandas as gpd
import streamlit as st
from streamlit_folium import st_folium

from geoplotter import GeoPlotter

MODE_COLORS = {
    "Bus": "#888888",
    "Métro": "#E74C3C",
    "RER": "#2471A3",
    "Tramway": "#27AE60",
    "Transilien": "#8E44AD",
    "TER": "#E67E22",
    "Navette aéroport": "#F39C12",
    "Autre": "#95A5A6",
}

ACCESSIBILITY_COLORS = {
    "true":    "#27AE60",  # green
    "partial": "#E67E22",  # orange
    "false":   "#E74C3C",  # red
    "unknown": "#888888",  # gray
}

ACCESSIBILITY_LABELS = {
    "true":    "Accessible",
    "partial": "Partiellement accessible",
    "false":   "Non accessible",
    "unknown": "Inconnu",
}

LINES_PATH = "data/processed/lines.geojson"
STOPS_PATH = "data/processed/stops.geojson"

MAX_STOPS_DEFAULT_ON = 2000


@st.cache_data
def load_data() -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    lines = gpd.read_file(LINES_PATH)
    stops = gpd.read_file(STOPS_PATH)
    return lines, stops


def apply_filters(
    gdf: gpd.GeoDataFrame,
    selected_modes: list[str],
    selected_lines: list[str],
) -> gpd.GeoDataFrame:
    if not selected_modes:
        return gdf.iloc[:0]
    out = gdf[gdf["mode"].isin(selected_modes)]
    if selected_lines:
        out = out[out["route_short_name"].isin(selected_lines)]
    return out


def main():
    st.set_page_config(page_title="Transports Île-de-France", layout="wide")
    st.title("Transports en commun — Île-de-France")
    st.info(
        "Pour de meilleures performances, sélectionnez d'abord un ou plusieurs "
        "numéros de ligne avant d'activer l'affichage des arrêts.",
        icon="💡",
    )

    lines, stops = load_data()

    # ── Sidebar ──────────────────────────────────────────────────────────────
    st.sidebar.header("Filtres")

    # Mode — Bus unchecked by default (1800+ lines slow to render)
    st.sidebar.subheader("Type de ligne")
    selected_modes = [
        mode for mode in MODE_COLORS if st.sidebar.checkbox(mode, value=(mode != "Bus"))
    ]

    lines_filtered = apply_filters(lines, selected_modes, [])

    # Line selector — options update based on selected modes
    st.sidebar.subheader("Numéro de ligne")
    available_lines = sorted(lines_filtered["route_short_name"].dropna().unique())
    selected_lines = st.sidebar.multiselect(
        "Sélectionner des lignes (vide = toutes)",
        options=available_lines,
    )

    if "Bus" in selected_modes and not selected_lines:
        st.sidebar.warning("Afficher toutes les lignes de bus peut être lent.")

    lines_filtered = apply_filters(lines, selected_modes, selected_lines)
    stops_filtered = apply_filters(stops, selected_modes, selected_lines)

    # Stops toggle — default off when stop count would be too large
    st.sidebar.subheader("Arrêts")
    stops_default = len(stops_filtered) <= MAX_STOPS_DEFAULT_ON
    show_stops = st.sidebar.checkbox("Afficher les arrêts", value=stops_default)
    if not stops_default and show_stops:
        st.sidebar.warning(
            f"{len(stops_filtered)} arrêts à afficher — cela peut être lent. "
            "Sélectionnez des lignes spécifiques pour réduire le nombre d'arrêts."
        )

    # Accessibility filter (only relevant when stops are shown)
    st.sidebar.subheader("Accessibilité")
    selected_accessibility = [
        key for key, label in ACCESSIBILITY_LABELS.items()
        if st.sidebar.checkbox(label, value=True)
    ]
    if show_stops and selected_accessibility:
        stops_filtered = stops_filtered[
            stops_filtered["ArRAccessibility"].isin(selected_accessibility)
        ]

    # ── Map ───────────────────────────────────────────────────────────────────
    stop_count = len(stops_filtered) if show_stops else 0
    st.caption(f"{len(lines_filtered)} tracé(s) · {stop_count} arrêt(s) affiché(s)")

    if lines_filtered.empty:
        st.info("Sélectionnez au moins un type de ligne dans le panneau latéral.")
    else:
        geoplotter = GeoPlotter(lines_filtered, geom_col="geometry", zoom_start=10)
        geoplotter.add_geodata_to_map(
            color_col="mode",
            colormap=MODE_COLORS,
            tooltip_cols=[
                "route_short_name",
                "route_long_name",
                "mode",
                "operatorname",
            ],
        )
        if show_stops and not stops_filtered.empty:
            geoplotter.add_geodata_from_gdf_to_map(
                stops_filtered,
                geom_col="geometry",
                color_col="ArRAccessibility",
                colormap=ACCESSIBILITY_COLORS,
                tooltip_cols=[
                    "stop_name",
                    "route_short_name",
                    "mode",
                    "nom_commune",
                    "ArRAccessibility",
                ],
                radius=5,
                fill=True,
                fill_opacity=0.8,
                weight=1,
            )
        st_folium(
            geoplotter.map, use_container_width=True, height=700, returned_objects=[]
        )


if __name__ == "__main__":
    main()
