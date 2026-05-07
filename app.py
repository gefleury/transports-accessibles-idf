import sys

sys.path.insert(0, "src")

import re

import geopandas as gpd
import streamlit as st
from streamlit_folium import st_folium

from geoplotter import GeoPlotter

MODE_COLORS = {
    "Bus": "#888888",
    "Métro": "#5DADE2",
    "RER": "#2471A3",
    "Tramway": "#27AE60",
    "Transilien": "#8E44AD",
    "TER": "#F48FB1",
    "Navette aéroport": "#F39C12",
    "Autre": "#95A5A6",
}

ACCESSIBILITY_COLORS = {
    "true": "#27AE60",  # green
    "partial": "#E67E22",  # orange
    "false": "#E74C3C",  # red
    "unknown": "#888888",  # gray
}

ACCESSIBILITY_LABELS = {
    "true": "Accessible",
    "partial": "Partiellement accessible",
    "false": "Non accessible",
    "unknown": "Inconnu",
}

ACCESSIBILITY_DEFAULT = {
    "true": True,
    "partial": True,
    "false": False,
    "unknown": False,
}

ACCESSIBILITY_LINE_COL = {
    "true": "has_accessible",
    "partial": "has_partial",
    "false": "has_inaccessible",
    "unknown": "has_unknown",
}

MODE_DEFAULT_ON = {"Métro", "RER", "Tramway"}

LINES_PATH = "data/processed/lines.geojson"
STOPS_PATH = "data/processed/stops.geojson"


@st.cache_data
def load_data() -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    lines = gpd.read_file(LINES_PATH)
    stops = gpd.read_file(STOPS_PATH)
    return lines, stops


def apply_filters(
    gdf: gpd.GeoDataFrame,
    mode_filters: dict[str, tuple[bool, list[str]]],
) -> gpd.GeoDataFrame:
    """Filter gdf by per-mode selections.

    mode_filters maps mode → (enabled, selected_lines).
    enabled + empty selected_lines → all lines of that mode.
    enabled + non-empty selected_lines → only those lines.
    disabled → nothing for that mode.
    """
    masks = []
    for mode, (enabled, selected_lines) in mode_filters.items():
        if not enabled:
            continue
        mask = gdf["mode"] == mode
        if selected_lines:
            mask = mask & gdf["route_long_name"].isin(selected_lines)
        masks.append(mask)

    if not masks:
        return gdf.iloc[:0]

    combined = masks[0]
    for m in masks[1:]:
        combined = combined | m
    return gdf[combined]


def _line_sort_key(name: str):
    # Natural sort: split into alternating text/number chunks so that embedded
    # numbers are compared numerically. E.g. "T3a" < "T3b" < "T4" < "T10".
    parts = re.split(r"(\d+)", str(name))
    return [int(p) if p.isdigit() else p.lower() for p in parts]


def main():
    st.set_page_config(page_title="Transports Île-de-France", layout="wide")
    st.title("Transports en commun — Île-de-France")

    lines, stops = load_data()

    # ── Sidebar ───────────────────────────────────────────────────────────────
    st.sidebar.header("Filtres")

    # ── Accessibility (top — focus of the app) ────────────────────────────────
    st.sidebar.subheader("Accessibilité des arrêts")
    selected_accessibility = []
    for key, label in ACCESSIBILITY_LABELS.items():
        col_check, col_dot = st.sidebar.columns([0.8, 0.2])
        if col_check.checkbox(label, value=ACCESSIBILITY_DEFAULT[key]):
            selected_accessibility.append(key)
        col_dot.markdown(
            f'<div style="background:{ACCESSIBILITY_COLORS[key]};width:14px;height:14px;'
            f'border-radius:50%;margin-top:13px"></div>',
            unsafe_allow_html=True,
        )
    # Stops are shown as long as at least one accessibility option is selected
    show_stops = bool(selected_accessibility)

    # ── Lines (per-mode expanders) ────────────────────────────────────────────
    st.sidebar.subheader("Lignes")
    st.sidebar.markdown(
        "<small>ℹ️ Seules les lignes ayant au moins un arrêt correspondant à l'accessibilité "
        "sélectionnée sont proposées. Par exemple, si seule la case « Accessible » est cochée, "
        "seules les lignes avec au moins un arrêt accessible apparaissent.</small>",
        unsafe_allow_html=True,
    )
    accessibility_cols = [ACCESSIBILITY_LINE_COL[k] for k in selected_accessibility]
    mode_filters = {}
    selected_bus_operators = []
    for mode in MODE_COLORS:
        default_enabled = mode in MODE_DEFAULT_ON
        with st.sidebar.expander(mode, expanded=default_enabled):
            st.markdown(
                f'<div style="background:{MODE_COLORS[mode]};height:4px;border-radius:2px;margin-bottom:4px"></div>',
                unsafe_allow_html=True,
            )
            if mode != "Bus":
                enabled = st.checkbox(
                    "Afficher toutes les lignes",
                    value=default_enabled,
                    key=f"enable_{mode}",
                )
            mode_df = lines[lines["mode"] == mode]
            if accessibility_cols:
                mode_df = mode_df[mode_df[accessibility_cols].any(axis=1)]
            if mode == "Bus":
                all_operators = sorted(mode_df["operatorname"].dropna().unique())
                selected_bus_operators = st.multiselect(
                    "Sélectionnez un opérateur spécifique",
                    options=all_operators,
                    key="operators_Bus",
                )
                if selected_bus_operators:
                    mode_df = mode_df[
                        mode_df["operatorname"].isin(selected_bus_operators)
                    ]
            mode_lines = sorted(
                mode_df["route_long_name"].dropna().unique(), key=_line_sort_key
            )
            selected_lines = st.multiselect(
                "Sélectionnez des lignes spécifiques",
                options=mode_lines,
                key=f"lines_{mode}",
            )
        if mode == "Bus":
            bus_active = bool(selected_bus_operators) or bool(selected_lines)
            mode_filters[mode] = (bus_active, selected_lines)
        else:
            mode_filters[mode] = (enabled, selected_lines)

    # ── Apply filters ─────────────────────────────────────────────────────────
    lines_filtered = apply_filters(lines, mode_filters)
    if accessibility_cols:
        lines_filtered = lines_filtered[lines_filtered[accessibility_cols].any(axis=1)]
    if selected_bus_operators:
        bus_mask = (lines_filtered["mode"] != "Bus") | lines_filtered[
            "operatorname"
        ].isin(selected_bus_operators)
        lines_filtered = lines_filtered[bus_mask]
    stops_filtered = stops[stops["id"].isin(lines_filtered["route_id"])]
    if show_stops:
        stops_filtered = stops_filtered[
            stops_filtered["ArRAccessibility"].isin(selected_accessibility)
        ]

    # ── Map ───────────────────────────────────────────────────────────────────
    stop_count = len(stops_filtered) if show_stops else 0
    col_stats, col_date = st.columns([0.7, 0.3])
    col_stats.caption(
        f"{len(lines_filtered)} tracé(s) · {stop_count} arrêt(s) affiché(s)"
    )
    col_date.markdown(
        '<div style="text-align:right"><small>Données mises à jour le 27/04/2026</small></div>',
        unsafe_allow_html=True,
    )
    if show_stops and stop_count > 2000:
        st.warning(
            f"{stop_count} arrêts correspondent à votre sélection! "
            "L'affichage peut être lent. Sélectionnez des lignes spécifiques "
            "pour réduire le nombre d'arrêts."
        )

    if lines_filtered.empty:
        st.info("Sélectionnez au moins un type de ligne dans le panneau latéral.")
    else:
        geoplotter = GeoPlotter(lines_filtered, geom_col="geometry", zoom_start=10)
        geoplotter.add_geodata_to_map(
            color_col="mode",
            colormap=MODE_COLORS,
            tooltip_html=lambda row: (
                f"<b>Ligne {row['route_long_name']}</b><br>"
                f"{row['mode']} ({row['operatorname']})"
            ),
        )
        if show_stops and not stops_filtered.empty:
            geoplotter.add_geodata_from_gdf_to_map(
                stops_filtered,
                geom_col="geometry",
                color_col="ArRAccessibility",
                colormap=ACCESSIBILITY_COLORS,
                tooltip_html=lambda row: (
                    f"<b>Arrêt \"{row['stop_name']}\"</b>"
                    # + (f" (commune de {row['nom_commune']})" if isinstance(row["nom_commune"], str) else "")
                    + f"<br>{row['mode']}, Ligne {row['route_long_name']}<br>"
                    + '<span style="color:'
                    + ACCESSIBILITY_COLORS[row["ArRAccessibility"]]
                    + '">♿ <b>'
                    + ACCESSIBILITY_LABELS[row["ArRAccessibility"]]
                    + "</b></span>"
                ),
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
