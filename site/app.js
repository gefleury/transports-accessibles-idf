// Interactive map of public-transport wheelchair accessibility in
// Île-de-France. Data: site/data/transports.pmtiles (tile layers `lines`
// and `stops`) and site/data/lines.json (sidebar records), both generated
// by src/build_tiles.py.

const MODE_COLORS = {
  "Bus": "#888888",
  "Métro": "#5DADE2",
  "RER": "#2471A3",
  "Tramway": "#27AE60",
  "Transilien": "#8E44AD",
  "TER": "#F48FB1",
  "Navette aéroport": "#F39C12",
  "Autre": "#95A5A6",
};
const ACCESS_COLORS = {
  "true": "#27AE60",
  "partial": "#E67E22",
  "false": "#E74C3C",
  "unknown": "#888888",
};
const ACCESS_LABELS = {
  "true": "Accessible",
  "partial": "Partiellement accessible",
  "false": "Non accessible",
  "unknown": "Inconnu",
};
const ACCESS_DEFAULT = { "true": true, "partial": true, "false": false, "unknown": false };
const ACCESS_FLAG = {
  "true": "has_accessible",
  "partial": "has_partial",
  "false": "has_inaccessible",
  "unknown": "has_unknown",
};
const MODE_DEFAULT_ON = new Set(["Métro", "RER", "Tramway"]);
const SEARCH_THRESHOLD = 12;  // add a search box above lists longer than this

const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

// ── State ────────────────────────────────────────────────────────────────────
let LINES = [];  // records from lines.json
const accessState = { ...ACCESS_DEFAULT };
const modeState = Object.fromEntries(Object.keys(MODE_COLORS).map(mode => [
  mode,
  { showAll: MODE_DEFAULT_ON.has(mode), lines: new Set(), operators: new Set() },
]));

const selectedAccess = () => Object.keys(accessState).filter(k => accessState[k]);

// ── Filtering logic (mirrors apply_filters in the Streamlit app) ─────────────
function lineMatchesAccess(line, access) {
  return access.length === 0 || access.some(k => line[ACCESS_FLAG[k]]);
}

// Line options offered in a mode's list: filtered by accessibility and, for
// Bus, by the selected operators — the map filter then works on selections
// pruned to these options.
function availableLines(mode) {
  const access = selectedAccess();
  return LINES.filter(l =>
    l.mode === mode
    && lineMatchesAccess(l, access)
    && (mode !== "Bus" || modeState.Bus.operators.size === 0
        || modeState.Bus.operators.has(l.operatorname))
  );
}

function visibleRouteIds() {
  const access = selectedAccess();
  const ids = [];
  for (const line of LINES) {
    const st = modeState[line.mode];
    if (!st) continue;
    const enabled = st.showAll || st.lines.size > 0
      || (line.mode === "Bus" && st.operators.size > 0);
    if (!enabled) continue;
    if (!lineMatchesAccess(line, access)) continue;
    if (line.mode === "Bus" && st.operators.size > 0
        && !st.operators.has(line.operatorname)) continue;
    if (st.lines.size > 0 && !st.lines.has(line.route_long_name)) continue;
    ids.push(line.route_id);
  }
  return ids;
}

function applyFilters() {
  const ids = visibleRouteIds();
  const access = selectedAccess();
  map.setFilter("lines", ["in", ["get", "route_id"], ["literal", ids]]);
  map.setFilter("stops", ["all",
    ["in", ["get", "id"], ["literal", ids]],
    ["in", ["get", "ArRAccessibility"], ["literal", access]],
  ]);
  // Mirror the Streamlit app: no accessibility selected → no stops at all.
  map.setLayoutProperty("stops", "visibility", access.length ? "visible" : "none");
  shownLineCount = ids.length;
  updateStats();
}

let shownLineCount = 0;

function updateStats() {
  let text = `${shownLineCount} ligne(s) affichée(s)`;
  if (selectedAccess().length > 0 && map.getZoom() < stopsMinzoom) {
    text += " — zoomez pour afficher les arrêts";
  }
  document.getElementById("stats").textContent = text;
}

// ── Sidebar widgets ──────────────────────────────────────────────────────────

function closeAllDropdowns() {
  document.querySelectorAll(".dropdown.open").forEach(d => d.classList.remove("open"));
}
// Close any open dropdown when clicking outside of it.
document.addEventListener("click", e => {
  if (!e.target.closest(".dropdown")) closeAllDropdowns();
});

// A closed-by-default dropdown of checkboxes (search box included above
// SEARCH_THRESHOLD options), mirroring a Streamlit multiselect: the toggle
// shows the current selection, the panel opens on click and stays open
// while checking options, and closes on an outside click.
function makeDropdown(container, values, selectionSet, onChange) {
  container.innerHTML = "";

  const dropdown = document.createElement("div");
  dropdown.className = "dropdown";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dropdown-toggle";
  toggle.addEventListener("click", () => {
    const wasOpen = dropdown.classList.contains("open");
    closeAllDropdowns();
    dropdown.classList.toggle("open", !wasOpen);
  });

  function updateToggleText() {
    const selected = values.filter(v => selectionSet.has(v));
    const text = selected.length === 0 ? "Sélectionner…"
      : selected.length <= 3 ? selected.join(", ")
      : `${selected.length} sélectionnées`;
    toggle.textContent = text;
    toggle.classList.toggle("placeholder", selected.length === 0);
  }

  const panel = document.createElement("div");
  panel.className = "dropdown-panel";

  let search = null;
  if (values.length > SEARCH_THRESHOLD) {
    search = document.createElement("input");
    search.className = "search";
    search.placeholder = "Rechercher…";
    panel.appendChild(search);
  }
  const list = document.createElement("div");
  list.className = "options";
  for (const value of values) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = selectionSet.has(value);
    box.addEventListener("change", () => {
      box.checked ? selectionSet.add(value) : selectionSet.delete(value);
      updateToggleText();
      onChange();
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(" " + value));
    list.appendChild(label);
  }
  panel.appendChild(list);
  if (search) {
    search.addEventListener("input", () => {
      const query = search.value.toLowerCase();
      for (const label of list.children) {
        label.style.display = label.textContent.toLowerCase().includes(query) ? "" : "none";
      }
    });
  }

  updateToggleText();
  dropdown.appendChild(toggle);
  dropdown.appendChild(panel);
  container.appendChild(dropdown);
}

// Direct references to each mode's option containers (mode names contain
// spaces/accents, so they are not safe to use as DOM ids).
const modeUI = {};  // mode → { linesDiv, operatorsDiv? }

// A specific line/operator selection means "toutes les lignes" is no longer
// literally true — uncheck it (state + UI) so the checkbox never lies about
// what's actually shown.
function syncShowAllCheckbox(mode) {
  const st = modeState[mode];
  const narrowed = st.lines.size > 0 || (mode === "Bus" && st.operators.size > 0);
  if (narrowed && st.showAll) {
    st.showAll = false;
    modeUI[mode].allBox.checked = false;
  }
}

// Rebuild the line list (and operator list for Bus) of one mode, pruning
// selections to the currently available options — like Streamlit multiselects.
function rebuildModeOptions(mode) {
  const st = modeState[mode];
  if (mode === "Bus") {
    const operators = [...new Set(
      LINES.filter(l => l.mode === "Bus" && l.operatorname != null
                        && lineMatchesAccess(l, selectedAccess()))
           .map(l => l.operatorname))].sort(collator.compare);
    for (const op of st.operators) if (!operators.includes(op)) st.operators.delete(op);
    makeDropdown(
      modeUI.Bus.operatorsDiv, operators, st.operators,
      () => { syncShowAllCheckbox("Bus"); rebuildModeOptions("Bus"); applyFilters(); },
    );
  }
  const names = [...new Set(availableLines(mode).map(l => l.route_long_name))]
    .sort(collator.compare);
  for (const name of st.lines) if (!names.includes(name)) st.lines.delete(name);
  makeDropdown(modeUI[mode].linesDiv, names, st.lines, () => {
    syncShowAllCheckbox(mode);
    applyFilters();
  });
}

function buildSidebar() {
  const accessDiv = document.getElementById("access");
  for (const [key, color] of Object.entries(ACCESS_COLORS)) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = accessState[key];
    box.addEventListener("change", () => {
      accessState[key] = box.checked;
      for (const mode of Object.keys(MODE_COLORS)) rebuildModeOptions(mode);
      applyFilters();
    });
    label.appendChild(box);
    label.insertAdjacentHTML("beforeend",
      ` <span class="swatch" style="background:${color}"></span> ${ACCESS_LABELS[key]}`);
    accessDiv.appendChild(label);
  }

  const modesDiv = document.getElementById("modes");
  for (const [mode, color] of Object.entries(MODE_COLORS)) {
    const details = document.createElement("details");
    details.open = MODE_DEFAULT_ON.has(mode);
    details.innerHTML =
      `<summary><span>${mode}</span><span class="bar" style="background:${color}"></span></summary>`;

    modeUI[mode] = {};

    const allLabel = document.createElement("label");
    const allBox = document.createElement("input");
    allBox.type = "checkbox";
    allBox.checked = modeState[mode].showAll;
    allBox.addEventListener("change", () => {
      modeState[mode].showAll = allBox.checked;
      if (allBox.checked) {
        // Checking "all" clears any narrower selection so it truly shows
        // every line, rather than leaving a stale selection in effect.
        modeState[mode].lines.clear();
        if (mode === "Bus") modeState[mode].operators.clear();
        rebuildModeOptions(mode);
      }
      applyFilters();
    });
    allLabel.appendChild(allBox);
    allLabel.appendChild(document.createTextNode(" Afficher toutes les lignes"));
    details.appendChild(allLabel);
    modeUI[mode].allBox = allBox;

    if (mode === "Bus") {
      details.insertAdjacentHTML("beforeend", '<div class="hint">Sélectionnez un opérateur spécifique</div>');
      modeUI.Bus.operatorsDiv = details.appendChild(document.createElement("div"));
    }
    details.insertAdjacentHTML("beforeend", '<div class="hint">Sélectionnez des lignes spécifiques</div>');
    modeUI[mode].linesDiv = details.appendChild(document.createElement("div"));
    modesDiv.appendChild(details);
  }
  for (const mode of Object.keys(MODE_COLORS)) rebuildModeOptions(mode);
}

// ── Map ──────────────────────────────────────────────────────────────────────
const TILES_URL = "data/transports.pmtiles";
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
const tilesFile = new pmtiles.PMTiles(TILES_URL);
protocol.add(tilesFile);

// Zoom below which the tiles contain no stops — read from the PMTiles
// metadata at startup (single source of truth: build_tiles.py).
let stopsMinzoom = 0;

const map = new maplibregl.Map({
  container: "map",
  center: [2.35, 48.75],
  zoom: 9.5,
  // Basemap: light minimal style with labels in each place's local
  // language (French here) — free, no API key. Tried and rejected as too
  // detailed: Plan IGN,
  // https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/attenue.json
  style: "https://tiles.openfreemap.org/styles/positron",
});

// Zoom +/- buttons, usable with the mouse alone (no scroll/pinch needed).
// showCompass: false keeps it to just zoom, no rotation control.
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

const LINES_LAYER = {
  id: "lines",
  type: "line",
  source: "transports",
  "source-layer": "lines",
  paint: {
    "line-color": ["match", ["get", "mode"],
      ...Object.entries(MODE_COLORS).flat(),
      "#95A5A6"],
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 2.5],
    "line-opacity": 0.8,
  },
  layout: { "line-cap": "round", "line-join": "round" },
};

const STOPS_LAYER = {
  id: "stops",
  type: "circle",
  source: "transports",
  "source-layer": "stops",
  // When a physical stop has both a confirmed-status line and an
  // unknown-status one stacked at the same point (both visible only if
  // "Inconnu" is checked), draw the confirmed one on top — otherwise which
  // color wins would be an arbitrary artifact of tile feature order.
  layout: {
    "circle-sort-key": ["match", ["get", "ArRAccessibility"], "unknown", 0, 1],
  },
  paint: {
    "circle-color": ["match", ["get", "ArRAccessibility"],
      ...Object.entries(ACCESS_COLORS).flat(),
      "#888888"],
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 11, 5, 14, 8],
    "circle-stroke-width": 1,
    "circle-stroke-color": "#ffffff",
    "circle-opacity": 0.85,
  },
};

map.on("load", async () => {
  map.addSource("transports", { type: "vector", url: "pmtiles://" + TILES_URL });
  // Insert beneath the basemap's first label layer so place names stay
  // readable on top of the transport lines and stops.
  const firstLabelId = map.getStyle().layers.find(l => l.type === "symbol")?.id;
  map.addLayer(LINES_LAYER, firstLabelId);
  map.addLayer(STOPS_LAYER, firstLabelId);

  const meta = await tilesFile.getMetadata();
  const stopsLayer = (meta.vector_layers ?? []).find(l => l.id === "stops");
  if (stopsLayer) {
    stopsMinzoom = stopsLayer.minzoom;
    map.setLayerZoomRange("stops", stopsMinzoom, 24);
  }

  const payload = await (await fetch("data/lines.json")).json();
  LINES = payload.lines;
  document.getElementById("updated").textContent =
    "Données mises à jour le " +
    new Date(payload.updated_on).toLocaleDateString("fr-FR");
  buildSidebar();
  applyFilters();
});
map.on("zoomend", updateStats);

// Hover tooltip: one persistent popup, shown while the cursor is over a
// line or a stop (stops take priority when both are under the cursor).
const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

// Several lines can share a physical stop, stacked at the same point on the
// map (e.g. Persan - Beaumont: TER + Transilien H). Keep one entry per
// (stop_id, route_long_name) — MapLibre can also report the same feature
// twice across a tile boundary, which this same dedup absorbs.
function dedupeStopLines(stopFeatures) {
  const seen = new Set();
  const lines = [];
  for (const f of stopFeatures) {
    const p = f.properties;
    const key = `${p.stop_id}|${p.route_long_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(p);
  }
  return lines;
}

function accessBadge(status) {
  return `<span style="color:${ACCESS_COLORS[status]}">♿ <b>${ACCESS_LABELS[status]}</b></span>`;
}

// One row per line serving the stop, instead of showing only whichever
// stacked feature happened to render on top.
function stopPopupHtml(stopFeatures) {
  const lines = dedupeStopLines(stopFeatures);
  const lineRows = lines
    .map(p => `${p.mode}, Ligne ${p.route_long_name}<br>${accessBadge(p.ArRAccessibility)}`)
    .join("<hr>");
  return `<b>Arrêt « ${lines[0].stop_name} »</b><br>${lineRows}`;
}

function linePopupHtml(lineFeature) {
  const p = lineFeature.properties;
  return `<b>Ligne ${p.route_long_name}</b><br>${p.mode} (${p.operatorname})`;
}

map.on("mousemove", e => {
  const features = map.queryRenderedFeatures(e.point, { layers: ["stops", "lines"] });
  if (!features.length) {
    hoverPopup.remove();
    map.getCanvas().style.cursor = "";
    return;
  }
  map.getCanvas().style.cursor = "pointer";

  const stopFeatures = features.filter(f => f.layer.id === "stops");
  const html = stopFeatures.length ? stopPopupHtml(stopFeatures) : linePopupHtml(features[0]);
  hoverPopup.setLngLat(e.lngLat).setHTML(html).addTo(map);
});
map.on("mouseout", () => {
  hoverPopup.remove();
  map.getCanvas().style.cursor = "";
});
