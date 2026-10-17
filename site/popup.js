// Popup of the line or stop under the cursor, selection on click, the map
// notice and the "Revenir à la vue d'ensemble" button, and Street View links.
// Uses: map, stopsMinzoom, ACCESS_COLORS, ACCESS_LABELS (app.js);
// selectedAccess (sidebar.js); setHighlight (highlight.js).

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
