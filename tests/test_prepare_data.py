"""Integration tests for prepare_data.py against the current source CSV files.

These tests:
- Verify that the input files have the columns required by the pipeline. They
  will fail with a clear message if the API delivers files with a different
  structure.
- Assert known accessibility values for specific stops (e.g. Châtelet).

Note: tests are skipped automatically when the data/ directory is absent (e.g.
in CI without the source files). Run them locally after downloading the data.

Run with:
    python -m pytest tests/
"""

import sys

sys.path.insert(0, "src")

import geopandas as gpd
import pandas as pd
import pytest

from prepare_data import (
    OUT_LINES,
    OUT_STOPS,
    RAW_ACCESSIBILITY_BUS,
    RAW_ACCESSIBILITY_TRAIN,
    RAW_STOPS,
    prepare_accessibility_metro,
)

DATA_AVAILABLE = RAW_STOPS.exists() and RAW_ACCESSIBILITY_BUS.exists() and RAW_ACCESSIBILITY_TRAIN.exists()
skip_if_no_data = pytest.mark.skipif(
    not DATA_AVAILABLE, reason="data/ files not present — skipping integration tests"
)

PROCESSED_AVAILABLE = OUT_STOPS.exists() and OUT_LINES.exists()
skip_if_no_processed = pytest.mark.skipif(
    not PROCESSED_AVAILABLE,
    reason="processed data/ files not present — run python src/prepare_data.py first",
)


@pytest.fixture(scope="module")
def gdf_stops():
    return gpd.read_file(RAW_STOPS)


@pytest.fixture(scope="module")
def df_accessibility_bus():
    return pd.read_csv(RAW_ACCESSIBILITY_BUS, sep=";")


@pytest.fixture(scope="module")
def df_accessibility_train():
    return pd.read_csv(RAW_ACCESSIBILITY_TRAIN, sep=";")


@pytest.fixture(scope="module")
def metro_accessibility(gdf_stops):
    return prepare_accessibility_metro(gdf_stops)


def _get_accessibility(result: pd.DataFrame, stop_id: str, line: str) -> str | None:
    rows = result[(result["stop_id"] == stop_id) & (result["route_long_name"] == line)]
    return rows["ArRAccessibility"].iloc[0] if not rows.empty else None


# ── Input file structure ──────────────────────────────────────────────────
# If any of these tests fail after updating the source files (e.g. from an
# API), it means the pipeline functions need to be updated to match the new
# schema.


@skip_if_no_data
def test_stops_required_columns(gdf_stops):
    required = {"stop_id", "route_long_name", "stop_name", "mode"}
    missing = required - set(gdf_stops.columns)
    assert not missing, f"arrets-lignes.geojson is missing columns: {missing}"


@skip_if_no_data
def test_bus_accessibility_required_columns(df_accessibility_bus):
    required = {"stop_id", "route_id", "arraccessibility"}
    missing = required - set(df_accessibility_bus.columns)
    assert not missing, f"sdap-arrets-associes.csv is missing columns: {missing}"


@skip_if_no_data
def test_train_accessibility_required_columns(df_accessibility_train):
    required = {"stop_point_id", "accessibility_level_id"}
    missing = required - set(df_accessibility_train.columns)
    assert not missing, f"accessibilite-en-gare.csv is missing columns: {missing}"


@skip_if_no_data
def test_bus_accessibility_values_are_valid(df_accessibility_bus):
    valid = {"true", "false", "partial", "unknown"}
    actual = set(df_accessibility_bus["arraccessibility"].dropna().unique())
    unexpected = actual - valid
    assert not unexpected, f"Unexpected arraccessibility values in bus file: {unexpected}"


@skip_if_no_data
def test_train_accessibility_level_ids_are_known(df_accessibility_train):
    known = {1, 3, 4, 6}
    actual = set(df_accessibility_train["accessibility_level_id"].dropna().unique())
    unexpected = actual - known
    assert not unexpected, f"Unknown accessibility_level_id values in train file: {unexpected}"


# ── prepare_accessibility_metro against the real stops file ────────────────


@skip_if_no_data
def test_chatelet_line_11_is_inaccessible(gdf_stops, metro_accessibility):
    chatelet_11 = gdf_stops[
        (gdf_stops["mode"] == "Metro")
        & (gdf_stops["route_long_name"] == "11")
        & (gdf_stops["stop_name"] == "Châtelet")
    ]
    assert not chatelet_11.empty, "Châtelet on line 11 not found in input — stop name may have changed"
    for stop_id in chatelet_11["stop_id"].unique():
        assert _get_accessibility(metro_accessibility, stop_id, "11") == "false", (
            f"Châtelet (stop_id={stop_id}) on line 11 should be inaccessible"
        )


@skip_if_no_data
def test_chatelet_line_14_is_accessible(gdf_stops, metro_accessibility):
    chatelet_14 = gdf_stops[
        (gdf_stops["mode"] == "Metro")
        & (gdf_stops["route_long_name"] == "14")
        & (gdf_stops["stop_name"] == "Châtelet")
    ]
    assert not chatelet_14.empty, "Châtelet on line 14 not found in input — stop name may have changed"
    for stop_id in chatelet_14["stop_id"].unique():
        assert _get_accessibility(metro_accessibility, stop_id, "14") == "true", (
            f"Châtelet (stop_id={stop_id}) on line 14 should be accessible"
        )


@skip_if_no_data
def test_porte_des_lilas_line_11_is_accessible(gdf_stops, metro_accessibility):
    pdl = gdf_stops[
        (gdf_stops["mode"] == "Metro")
        & (gdf_stops["route_long_name"] == "11")
        & (gdf_stops["stop_name"] == "Porte des Lilas")
    ]
    assert not pdl.empty, "Porte des Lilas on line 11 not found — stop name may have changed"
    for stop_id in pdl["stop_id"].unique():
        assert _get_accessibility(metro_accessibility, stop_id, "11") == "true", (
            f"Porte des Lilas (stop_id={stop_id}) on line 11 should be accessible"
        )


@skip_if_no_data
def test_metro_output_values_are_valid(metro_accessibility):
    valid = {"true", "false"}
    unexpected = set(metro_accessibility["ArRAccessibility"].unique()) - valid
    assert not unexpected, f"Unexpected ArRAccessibility values in metro output: {unexpected}"


@skip_if_no_data
def test_metro_output_columns(metro_accessibility):
    for col in ("stop_id", "route_long_name", "ArRAccessibility"):
        assert col in metro_accessibility.columns


# ── End-to-end tests on the processed GeoJSON files ─────────────────────────
# These catch bugs in join_accessibility, join_stops_to_lines, and
# join_line_accessibility that individual prepare_* tests would miss.
# Run `python src/prepare_data.py` before running these tests.


@pytest.fixture(scope="module")
def processed_stops():
    return gpd.read_file(OUT_STOPS)


@pytest.fixture(scope="module")
def processed_lines():
    return gpd.read_file(OUT_LINES)


@skip_if_no_processed
def test_stops_accessibility_values_are_valid(processed_stops):
    valid = {"true", "false", "partial", "unknown"}
    unexpected = set(processed_stops["ArRAccessibility"].unique()) - valid
    assert not unexpected, f"Unexpected ArRAccessibility values in stops: {unexpected}"


@skip_if_no_processed
def test_processed_chatelet_line_11_is_inaccessible(processed_stops):
    rows = processed_stops[
        (processed_stops["stop_name"] == "Châtelet")
        & (processed_stops["route_long_name"] == "11")
        & (processed_stops["mode"] == "Métro")
    ]
    assert not rows.empty, "Châtelet on line 11 not found in processed stops"
    assert (rows["ArRAccessibility"] == "false").all(), (
        "Châtelet on line 11 should be 'false' in processed stops"
    )


@skip_if_no_processed
def test_processed_chatelet_line_14_is_accessible(processed_stops):
    rows = processed_stops[
        (processed_stops["stop_name"] == "Châtelet")
        & (processed_stops["route_long_name"] == "14")
        & (processed_stops["mode"] == "Métro")
    ]
    assert not rows.empty, "Châtelet on line 14 not found in processed stops"
    assert (rows["ArRAccessibility"] == "true").all(), (
        "Châtelet on line 14 should be 'true' in processed stops"
    )


@skip_if_no_processed
def test_tramway_stops_are_all_accessible(processed_stops):
    tramway = processed_stops[processed_stops["mode"] == "Tramway"]
    assert not tramway.empty, "No tramway stops found in processed stops"
    assert (tramway["ArRAccessibility"] == "true").all(), "All tramway stops should be 'true'"


@skip_if_no_processed
def test_metro_line_14_has_accessible_flag(processed_lines):
    line_14 = processed_lines[
        (processed_lines["mode"] == "Métro") & (processed_lines["route_long_name"] == "14")
    ]
    assert not line_14.empty, "Metro line 14 not found in processed lines"
    assert line_14["has_accessible"].all(), "Metro line 14 should have has_accessible=True"


@skip_if_no_processed
def test_metro_line_11_has_both_accessible_and_inaccessible_flags(processed_lines):
    line_11 = processed_lines[
        (processed_lines["mode"] == "Métro") & (processed_lines["route_long_name"] == "11")
    ]
    assert not line_11.empty, "Metro line 11 not found in processed lines"
    assert line_11["has_accessible"].any(), "Metro line 11 should have has_accessible=True"
    assert line_11["has_inaccessible"].any(), "Metro line 11 should have has_inaccessible=True"


@skip_if_no_processed
def test_lines_accessibility_flags_are_boolean(processed_lines):
    for col in ("has_accessible", "has_partial", "has_inaccessible", "has_unknown"):
        assert col in processed_lines.columns, f"Missing column: {col}"
        unexpected = set(processed_lines[col].unique()) - {True, False}
        assert not unexpected, f"Column {col} contains non-boolean values: {unexpected}"


@skip_if_no_processed
def test_no_stops_with_missing_mode(processed_stops):
    assert not processed_stops["mode"].isna().any(), (
        "Some stops have no mode — orphan stops may be leaking into the output"
    )
