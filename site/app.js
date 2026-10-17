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
const ACCESS_COUNT_FIELD = {
  "true": "count_accessible",
  "partial": "count_partial",
  "false": "count_inaccessible",
  "unknown": "count_unknown",
};
// A line needs at least this many stops matching the selected accessibility
// criteria to be considered usable — a single matching stop isn't enough to
// board and alight accessibly.
const MIN_MATCHING_STOPS = 2;
document.getElementById("lines-hint").textContent =
  `Seules les lignes ayant au moins ${MIN_MATCHING_STOPS} arrêts correspondant ` +
  "à l'accessibilité sélectionnée sont affichées et proposées dans les listes.";
const MODE_DEFAULT_ON = new Set(["Métro", "RER", "Tramway"]);
const SEARCH_THRESHOLD = 12;  // add a search box above lists longer than this

// The sidebar starts open in the HTML (so desktop needs no JS at all);
// collapse it where it's stacked above the map (narrow portrait screens,
// same query as style.css) so the map isn't pushed below the fold.
// Keep it in sync on live resizes too (not just at load), in both
// directions — e.g. rotating a tablet from portrait to landscape should
// re-open it, and the reverse should re-collapse it, regardless of
// whatever collapsed/expanded state it happened to be left in (desktop
// also has its own hide/show toggle now, but defaulting to open there
// avoids landing on a collapsed sidebar just by coincidence of whatever
// state the narrower layout left it in).
const sidebarMobileQuery = window.matchMedia(
  "(max-width: 1024px) and (orientation: portrait), (max-width: 1024px) and (min-height: 501px)"
);
function syncSidebarOpenToWidth(isMobile) {
  const sidebar = document.getElementById("sidebar");
  if (isMobile) sidebar.removeAttribute("open");
  else sidebar.setAttribute("open", "");
}
syncSidebarOpenToWidth(sidebarMobileQuery.matches);
sidebarMobileQuery.addEventListener("change", e => syncSidebarOpenToWidth(e.matches));

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
  // Mirror the stops layer: no accessibility criteria selected → nothing matches.
  if (access.length === 0) return false;
  const matchingStops = access.reduce((sum, k) => sum + line[ACCESS_COUNT_FIELD[k]], 0);
  return matchingStops >= MIN_MATCHING_STOPS;
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
  // Base layers and their highlight copies (highlight.js) share filters.
  for (const id of ["lines", ...LINES_COPY_IDS]) {
    map.setFilter(id, ["in", ["get", "route_id"], ["literal", ids]]);
  }
  for (const id of ["stops", ...STOPS_COPY_IDS]) {
    map.setFilter(id, ["all",
      ["in", ["get", "id"], ["literal", ids]],
      ["in", ["get", "ArRAccessibility"], ["literal", access]],
    ]);
    // Mirror the Streamlit app: no accessibility selected → no stops at all.
    map.setLayoutProperty(id, "visibility", access.length ? "visible" : "none");
  }
  shownLineCount = ids.length;
  updateStats();
}

let shownLineCount = 0;

function updateStats() {
  document.getElementById("stats").textContent = `${shownLineCount} ligne(s) affichée(s)`;
  updateMapNotice();  // its zoom hint depends on the same state
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
  center: [2.3522, 48.8566],
  zoom: 10,
  // Basemap: light minimal style with labels in each place's local
  // language (French here) — free, no API key. Tried and rejected as too
  // detailed: Plan IGN,
  // https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/attenue.json
  style: "https://tiles.openfreemap.org/styles/positron",
});

// Zoom +/- buttons, usable with the mouse alone (no scroll/pinch needed).
// showCompass: false keeps it to just zoom, no rotation control.
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

// MapLibre's compact attribution control starts open when the attached text
// is short enough to fit — collapse it to just the toggle icon. Done here
// rather than on "load" (which fires after the style/tiles finish loading)
// to avoid a flash of the expanded control on every page load.
document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");

// Color by a feature property, e.g. a line's mode → MODE_COLORS; `transform`
// derives other shades (the faded ones in highlight.js).
function colorExpression(property, colors, fallback, transform = c => c) {
  return ["match", ["get", property],
    ...Object.entries(colors).flatMap(([value, color]) => [value, transform(color)]),
    transform(fallback)];
}
const lineColor = transform => colorExpression("mode", MODE_COLORS, "#95A5A6", transform);
const stopColor = transform => colorExpression("ArRAccessibility", ACCESS_COLORS, "#888888", transform);

const LINES_LAYER = {
  id: "lines",
  type: "line",
  source: "transports",
  "source-layer": "lines",
  // Nothing shown until applyFilters() runs — avoids a flash of every line
  // while lines.json and the tile metadata are still loading.
  filter: ["in", ["get", "route_id"], ["literal", []]],
  paint: {
    "line-color": lineColor(),
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
  // Nothing shown until applyFilters() runs — avoids a flash of every stop
  // while lines.json and the tile metadata are still loading.
  filter: ["in", ["get", "id"], ["literal", []]],
  // When a physical stop has both a confirmed-status line and an
  // unknown-status one stacked at the same point (both visible only if
  // "Inconnu" is checked), draw the confirmed one on top — otherwise which
  // color wins would be an arbitrary artifact of tile feature order.
  layout: {
    visibility: "none",
    "circle-sort-key": ["match", ["get", "ArRAccessibility"], "unknown", 0, 1],
  },
  paint: {
    "circle-color": stopColor(),
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 11, 5, 14, 8],
    "circle-stroke-width": 1,
    "circle-stroke-color": "#ffffff",
    "circle-opacity": 0.85,
  },
};

map.on("load", async () => {

  // promoteId: feature ids for feature-state (the highlight, highlight.js) —
  // a line's id for both its segments and its stops.
  map.addSource("transports", {
    type: "vector",
    url: "pmtiles://" + TILES_URL,
    promoteId: { lines: "route_id", stops: "id" },
  });
  // Insert beneath the basemap's first label layer so place names stay
  // readable on top of the transport lines and stops.
  const firstLabelId = map.getStyle().layers.find(l => l.type === "symbol")?.id;
  map.addLayer(LINES_LAYER, firstLabelId);
  map.addLayer(STOPS_LAYER, firstLabelId);
  addHighlightLayers(firstLabelId);

  const meta = await tilesFile.getMetadata();
  const stopsLayer = (meta.vector_layers ?? []).find(l => l.id === "stops");
  if (stopsLayer) {
    stopsMinzoom = stopsLayer.minzoom;
    for (const id of ["stops", ...STOPS_COPY_IDS]) map.setLayerZoomRange(id, stopsMinzoom, 24);
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

// One persistent popup for the line or stop under the cursor (stops take
// priority when both are). Hovering only previews it. Clicking selects:
// the selection is highlighted (highlight.js — on click only, as fading the
// whole map on every mouse move was tiring) and its popup pinned, so its
// Street View links can be reached. Wider than MapLibre's 240px default to
// fit long stop names next to the icon, but capped so it still fits within
// the map on narrow phones. focusAfterOpen: false, or MapLibre would focus
// the first Street View link each time the popup opens, showing its focus
// style. The close button only shows on a pinned popup (CSS, .pinned):
// closing it uncovers the map but keeps the selection, until a click on an
// empty spot of the map or the "Revenir à la vue d'ensemble" button.
const hoverPopup = new maplibregl.Popup({
  closeButton: true, closeOnClick: false, focusAfterOpen: false, maxWidth: "min(300px, 75vw)",
});
let selectionActive = false;

// Notice at the top of the map: how to show stops when zoomed out, and how
// to select — the latter only while hovering a line or stop, and until the
// user has selected once (remembered in the browser; shown again if storage
// is unavailable). Deselecting needs no hint: the "Revenir à la vue d'ensemble"
// button says it.
const SELECT_HINT_KEY = "hint-learned-select";
function selectHintLearned() {
  try { return localStorage.getItem(SELECT_HINT_KEY) === "1"; } catch { return false; }
}
function learnSelectHint() {
  try { localStorage.setItem(SELECT_HINT_KEY, "1"); } catch { /* not remembered */ }
}

// Hidden until there's something to say — else an empty box shows while the
// map loads.
const mapNotice = document.createElement("div");
mapNotice.className = "map-notice";
mapNotice.setAttribute("role", "status");
mapNotice.hidden = true;
document.getElementById("map").appendChild(mapNotice);

function updateMapNotice() {
  const messages = [];
  if (selectedAccess().length > 0 && map.getZoom() < stopsMinzoom) {
    messages.push("Zoomez pour afficher les arrêts");
  }
  if (!selectionActive && hoverPopup.isOpen() && !selectHintLearned()) {
    messages.push(`Astuce\u00a0: cliquez pour faire ressortir ${popupSubject}`);
  }
  const html = messages
    .map(m => `<div><svg width="16" height="16" aria-hidden="true"><use href="#icon-info" /></svg>${m}</div>`)
    .join("");
  if (mapNotice.innerHTML !== html) mapNotice.innerHTML = html;  // called on every mouse move
  mapNotice.hidden = messages.length === 0;
}

// Shown at the bottom of the map while a selection is active — the way back
// once the popup is closed, also on touch devices.
const deselectButton = document.createElement("button");
deselectButton.type = "button";
deselectButton.className = "deselect-button";
deselectButton.textContent = "Revenir à la vue d'ensemble";
deselectButton.hidden = true;
deselectButton.addEventListener("click", () => clearSelection());
document.getElementById("map").appendChild(deselectButton);

// A stop name's Street View link is shown only if all its stop points under
// the cursor lie within this distance of each other. Further apart (e.g. a
// bus stop's two directions on opposite sides of a street, median 33 m),
// the link could show the wrong one — zooming in until the cursor catches
// a single point brings it back.
const STREETVIEW_MAX_SPREAD_M = 20;

// Several lines can share a stop, stacked at the same point on the map
// (e.g. Persan - Beaumont: TER + Transilien H) — keep one entry per
// (stop_name, mode, route_long_name). This also absorbs the same feature
// reported twice across a tile boundary, and a line's separate platforms
// (different stop_id, same station) caught together at low zoom. Those
// platforms can differ in accessibility (e.g. bus 1 at Cottages: one
// direction partial, the other not) — so every distinct status is kept
// rather than only the first one found.
function groupStopLines(stopFeatures) {
  const byStop = new Map();
  for (const f of stopFeatures) {
    const p = f.properties;
    if (!byStop.has(p.stop_name)) byStop.set(p.stop_name, new Map());
    const stopLines = byStop.get(p.stop_name);
    const key = `${p.mode}|${p.route_long_name}`;
    if (!stopLines.has(key)) stopLines.set(key, { ...p, statuses: new Set() });
    stopLines.get(key).statuses.add(p.ArRAccessibility);
  }
  return byStop;
}

// data-* attributes: no effect on display, they let tests read the popup's
// structure without depending on its wording (tests/test_site.py).
function accessBadge(status) {
  return `<span data-accessibility="${status}" style="color:${ACCESS_COLORS[status]}">♿ <b>${ACCESS_LABELS[status]}</b></span>`;
}

// Where a stop point's Street View link should point: its station entrance
// when it has one (prepare_data.py's add_streetview_coordinates — station
// platforms are often far from any street panorama), else the stop itself.
function streetViewLocation(stopFeature) {
  const p = stopFeature.properties;
  return p.streetview_lng != null
    ? new maplibregl.LngLat(p.streetview_lng, p.streetview_lat)
    : maplibregl.LngLat.convert(stopFeature.geometry.coordinates);
}

// For each stop name, where its Street View link should point: the location
// of its stop point nearest to the cursor, if all its points' locations are
// within STREETVIEW_MAX_SPREAD_M of each other, else null (no link).
function streetViewTargets(stopFeatures, point) {
  const pointsByStop = new Map();
  for (const f of stopFeatures) {
    const { stop_name, stop_id } = f.properties;
    if (!pointsByStop.has(stop_name)) pointsByStop.set(stop_name, new Map());
    pointsByStop.get(stop_name).set(stop_id, {
      onScreen: map.project(f.geometry.coordinates),
      location: streetViewLocation(f),
    });
  }
  const targets = new Map();
  for (const [stopName, byId] of pointsByStop) {
    const points = Array.from(byId.values());
    const compact = points.every(a =>
      points.every(b => a.location.distanceTo(b.location) <= STREETVIEW_MAX_SPREAD_M));
    const nearest = points.reduce((best, p) =>
      p.onScreen.dist(point) < best.onScreen.dist(point) ? p : best);
    targets.set(stopName, compact ? nearest.location : null);
  }
  return targets;
}

// Google Maps URLs API: opens the panorama nearest to the point, in the
// Google Maps app on mobile when installed. hl=fr forces the French UI.
function streetViewLink({ lng, lat }) {
  const url = "https://www.google.com/maps/@?api=1&map_action=pano"
    + `&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}&hl=fr`;
  return `<a class="streetview-link" href="${url}" target="_blank" rel="noopener"
    title="Voir dans Google Street View" aria-label="Voir dans Google Street View">
    <svg width="21" height="21" aria-hidden="true"><use href="#icon-camera" /></svg></a>`;
}

// Shown instead of the link when the stop's points under the cursor are too
// far apart to pick one: a struck-through grey icon, so the link doesn't seem
// to vanish at random, plus a short hint to its right saying how to get it
// (a tooltip wouldn't show on touch devices).
const STREETVIEW_AMBIGUOUS_ICON = `<span class="streetview-link is-disabled" aria-hidden="true">
  <svg width="21" height="21" viewBox="0 0 24 24"><use href="#icon-camera" />
    <path d="M2.5 2.5l19 19" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" /></svg></span>`;
const STREETVIEW_AMBIGUOUS_NOTE = '<span class="streetview-hint">Zoomez</span>';

function lineRowHtml(line) {
  // Fixed order (accessible first), whichever platform was found first.
  const badges = Object.keys(ACCESS_LABELS)
    .filter(status => line.statuses.has(status))
    .map(accessBadge)
    .join("<br>");
  // TER and Transilien stations can list several platforms ("quais");
  // other modes' stops are split by direction of travel.
  const splitBy = ["TER", "Transilien"].includes(line.mode) ? "le quai" : "le sens";
  const note = line.statuses.size > 1 ? `<br><i class="status-note">(selon ${splitBy})</i>` : "";
  return `<div data-line="${line.mode} ${line.route_long_name}">`
    + `${line.mode}, Ligne ${line.route_long_name}<br>${badges}${note}</div>`;
}

// One row per line serving the stop, instead of showing only whichever
// stacked feature happened to render on top. At low zoom the cursor's hit
// radius can also span distinct nearby stations (e.g. the funicular's
// "Gare basse" and "Gare haute", ~1km apart but close on screen when
// zoomed out) — group by stop_name so each gets its own header instead of
// being merged under one. Each header gets at most one Street View link
// (see STREETVIEW_MAX_SPREAD_M).
function stopPopupHtml(stopFeatures, point) {
  const targets = streetViewTargets(stopFeatures, point);
  return Array.from(groupStopLines(stopFeatures), ([stopName, stopLines]) => {
    const lineRows = Array.from(stopLines.values(), lineRowHtml)
      .join('<hr class="line-separator">');
    const target = targets.get(stopName);
    const link = target ? streetViewLink(target) : STREETVIEW_AMBIGUOUS_ICON;
    const note = target ? "" : STREETVIEW_AMBIGUOUS_NOTE;
    return `<div class="stop-title"><b>Arrêt « ${stopName} »</b>${link}${note}</div>${lineRows}`;
  }).join('<hr class="stop-separator">');
}

function linePopupHtml(lineFeature) {
  const p = lineFeature.properties;
  return `<b>Ligne ${p.route_long_name}</b><br>${p.mode} (${p.operatorname})`;
}

const featuresAt = point => map.queryRenderedFeatures(point, { layers: ["stops", "lines"] });
const stopsAmong = features => features.filter(f => f.layer.id === "stops");

// What the popup is about, for the select hint (updateMapNotice).
let popupSubject = "";
function showPopup(features, point, lngLat, pinned) {
  const stopFeatures = stopsAmong(features);
  const stopNames = new Set(stopFeatures.map(f => f.properties.stop_name));
  popupSubject = stopNames.size > 1 ? "ces arrêts et leurs lignes"
    : stopNames.size === 1 ? "cet arrêt et ses lignes"
    : "cette ligne";
  const html = stopFeatures.length ? stopPopupHtml(stopFeatures, point) : linePopupHtml(features[0]);
  hoverPopup.setLngLat(lngLat).setHTML(html).addTo(map);
  if (pinned) hoverPopup.addClassName("pinned");
  else hoverPopup.removeClassName("pinned");
}

function hidePopup() {
  hoverPopup.remove();
  updateMapNotice();
}

// A stop highlights itself and every line serving it (all those listed in
// its popup); a line, only itself.
function select(features, point, lngLat) {
  const stopFeatures = stopsAmong(features);
  if (stopFeatures.length) {
    setHighlight(stopFeatures.map(f => f.properties.id), stopFeatures);
  } else {
    setHighlight([features[0].properties.route_id], []);
  }
  learnSelectHint();
  showPopup(features, point, lngLat, true);
  selectionActive = true;
  deselectButton.hidden = false;
  updateMapNotice();
}

function clearSelection() {
  setHighlight([], []);
  selectionActive = false;
  deselectButton.hidden = true;
  hidePopup();
}

// While a selection is active, hovering leaves it (and its popup) alone.
map.on("mousemove", e => {
  const features = featuresAt(e.point);
  map.getCanvas().style.cursor = features.length ? "pointer" : "";
  if (selectionActive) return;
  if (features.length) {
    showPopup(features, e.point, e.lngLat, false);
    updateMapNotice();
  } else {
    hidePopup();
  }
});
map.on("mouseout", () => {
  if (!selectionActive) hidePopup();
  map.getCanvas().style.cursor = "";
});
// Clicking a feature selects it; clicking an empty spot deselects. Also the
// only way to open a popup on touch devices, where a tap never fires
// mousemove (nor the mouseout that would close it).
map.on("click", e => {
  const features = featuresAt(e.point);
  if (features.length) select(features, e.point, e.lngLat);
  else clearSelection();
});
