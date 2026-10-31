// Popup of the line or stop under the cursor, selection on click (or second
// tap), the map notice and the "Revenir à la vue d'ensemble" button, and
// Street View links.
// Uses: map, stopsMinzoom, ACCESS_COLORS, ACCESS_LABELS (app.js);
// selectedAccess (sidebar.js); setHighlight (highlight.js).

// One persistent popup for the line or stop under the cursor (stops take
// priority when both are). Hovering only previews it. Clicking selects:
// the selection is highlighted (highlight.js — on click only, as fading the
// whole map on every mouse move was tiring) and its popup pinned. A finger
// can't hover: its first tap previews, a second one selects (see the click
// handler). Wider than MapLibre's 240px default to
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

// Whether the map is used with a finger rather than a mouse, trackpad or pen.
// Read from each input, not from the screen size: a narrow desktop window
// keeps the mouse behavior, a touchscreen laptop switches as soon as it's
// touched. Listened to on the whole map, so that taps on the popup count too.
let touchInput = false;
for (const type of ["pointerdown", "pointermove"]) {
  map.getContainer().addEventListener(type, e => { touchInput = e.pointerType === "touch"; });
}

// ── Map notice and "Revenir à la vue d'ensemble" button ─────────────────────

// Notice at the top of the map: how to show stops when zoomed out, and how
// to select — the latter only while hovering a line or stop, and until the
// user has selected once during this visit (not remembered across visits:
// a hint missed or skipped once would then never come back). Deselecting
// needs no hint: the "Revenir à la vue d'ensemble" button says it.
let selectHintLearned = false;

// Hidden until there's something to say — else an empty box shows while the
// map loads.
const mapNotice = document.createElement("div");
mapNotice.className = "map-notice";
mapNotice.setAttribute("role", "status");
mapNotice.hidden = true;
document.getElementById("map").appendChild(mapNotice);

// data-hint: lets tests tell the messages apart without reading their wording.
function updateMapNotice() {
  const messages = [];  // [hint id, text]
  if (selectedAccess().length > 0 && map.getZoom() < stopsMinzoom) {
    messages.push(["zoom", "Zoomez pour afficher les arrêts"]);
  }
  if (!selectionActive && hoverPopup.isOpen() && !selectHintLearned) {
    // A finger has already tapped once to open the popup.
    const action = touchInput ? "Cliquez \u00e0 nouveau" : "Cliquez";
    messages.push(["select", `${action} pour faire ressortir ${shownSubject.label}`]);
  }
  const html = messages
    .map(([id, text]) => `<div data-hint="${id}">`
      + `<svg width="19" height="19" aria-hidden="true"><use href="#icon-info" /></svg>${text}</div>`)
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

// ── Popup content ───────────────────────────────────────────────────────────

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

// ── Popup, selection, mouse and touch ───────────────────────────────────────

const stopsAmong = features => features.filter(f => f.layer.id === "stops");

// A finger is less precise than a mouse, and hides what it taps: a tap
// within this distance of a stop's center catches it — a target ~40px
// across, close to the 44px recommended for touch, without bigger circles.
const STOP_TOUCH_TOLERANCE_PX = 20;
// Lines are thinner still, but run almost everywhere in Paris: a wider
// tolerance would leave no empty spot to tap to deselect.
const LINE_TOUCH_TOLERANCE_PX = 10;

// Distance in pixels from a point to the segment [a, b].
function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
    : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

// Distance in pixels from a point to a stop or line on screen.
function screenDistance(point, f) {
  const g = f.geometry;
  if (g.type === "Point") {
    const p = map.project(g.coordinates);
    return Math.hypot(p.x - point.x, p.y - point.y);
  }
  const paths = g.type === "LineString" ? [g.coordinates] : g.coordinates;
  let d = Infinity;
  for (const path of paths) {
    const pts = path.map(c => map.project(c));
    for (let i = 1; i < pts.length; i++) d = Math.min(d, segmentDistance(point, pts[i - 1], pts[i]));
  }
  return d;
}

// The features of a layer within r pixels of a point, nearest first.
function featuresNear(point, layer, r) {
  const box = [[point.x - r, point.y - r], [point.x + r, point.y + r]];
  return map.queryRenderedFeatures(box, { layers: [layer] })
    .map(f => ({ f, d: screenDistance(point, f) }))
    .filter(({ d }) => d <= r)
    .sort((a, b) => a.d - b.d)
    .map(({ f }) => f);
}

// The stops and lines under the cursor or finger. A tap hitting no stop
// exactly takes the stop nearest to it within STOP_TOUCH_TOLERANCE_PX, with
// the other points of its name (its directions, platforms), as an exact tap
// would — preferred to a line under the finger, which its popup lists. A tap
// hitting nothing takes the line nearest to it within LINE_TOUCH_TOLERANCE_PX.
function featuresAt(point) {
  const exact = map.queryRenderedFeatures(point, { layers: ["stops", "lines"] });
  if (!touchInput || stopsAmong(exact).length) return exact;
  const stops = featuresNear(point, "stops", STOP_TOUCH_TOLERANCE_PX);
  if (stops.length) return stops.filter(f => f.properties.stop_name === stops[0].properties.stop_name);
  if (exact.length) return exact;
  return featuresNear(point, "lines", LINE_TOUCH_TOLERANCE_PX).slice(0, 1);
}

// What a popup is about: its stops, or else its line. `key` tells whether two
// taps aimed at the same stop point or line: the stop_id of the stop nearest
// to the finger, not the stops caught (a finger rarely lands twice on the
// same pixel, so they can differ) nor their name (the other direction of a
// bus stop has the same name: tapping it must preview it, not select).
// `label` names it in the select hint (updateMapNotice).
function popupSubject(features, point) {
  const stopFeatures = stopsAmong(features);
  if (stopFeatures.length === 0) {
    return { key: features[0].properties.route_id, label: "cette ligne" };
  }
  const nearest = stopFeatures.reduce((a, b) =>
    (screenDistance(point, b) < screenDistance(point, a) ? b : a));
  const stopNames = new Set(stopFeatures.map(f => f.properties.stop_name));
  return {
    key: `stop:${nearest.properties.stop_id}`,
    label: stopNames.size > 1 ? "ces arrêts et leurs lignes" : "cet arrêt et ses lignes",
  };
}

let shownSubject = null;  // popupSubject() of the open popup
function showPopup(features, point, lngLat, pinned) {
  const stopFeatures = stopsAmong(features);
  shownSubject = popupSubject(features, point);
  const html = stopFeatures.length ? stopPopupHtml(stopFeatures, point) : linePopupHtml(features[0]);
  hoverPopup.setLngLat(lngLat).setHTML(html).addTo(map);
  if (pinned) hoverPopup.addClassName("pinned");
  else hoverPopup.removeClassName("pinned");
}

function hidePopup() {
  hoverPopup.remove();
  updateMapNotice();
}

// The popup alone, without highlighting: on hover, or on a first tap.
function preview(features, point, lngLat) {
  showPopup(features, point, lngLat, false);
  updateMapNotice();
}

// Whether the open popup is about the stop point or line tapped at `point`.
function isShown(features, point) {
  return hoverPopup.isOpen() && shownSubject.key === popupSubject(features, point).key;
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
  selectHintLearned = true;
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

// Hovering previews; while a selection is active, it leaves the selection
// (and its popup) alone. Ignored for a finger: a tap also fires a mousemove
// before its click, and iOS then drops the click if the page changed in
// response (taking it for a hover menu) — so taps are handled on click only.
map.on("mousemove", e => {
  if (touchInput) return;
  const features = featuresAt(e.point);
  map.getCanvas().style.cursor = features.length ? "pointer" : "";
  if (selectionActive) return;
  if (features.length) preview(features, e.point, e.lngLat);
  else hidePopup();
});
map.on("mouseout", () => {
  if (touchInput) return;
  if (!selectionActive) hidePopup();
  map.getCanvas().style.cursor = "";
});

// Clicking a stop or line selects it; clicking an empty spot deselects. With
// a finger, a first tap previews and a second one on the same stop point or
// line selects — but once a selection is active, a tap on another one
// selects it at once.
map.on("click", e => {
  const features = featuresAt(e.point);
  if (features.length === 0) clearSelection();
  else if (touchInput && !selectionActive && !isShown(features, e.point)) preview(features, e.point, e.lngLat);
  else select(features, e.point, e.lngLat);
});
