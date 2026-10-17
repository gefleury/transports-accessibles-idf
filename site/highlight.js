// Highlight of the hovered or pinned line(s)/stop on the map (loaded after
// app.js, whose base layers, colors and `map` it builds on).
//
// While something is highlighted, the highlighted lines and their stops stay
// in full color (the lines thicker, on top), the hovered stop is enlarged
// with a thicker white outline, and everything else fades to a pale color.
//
// Every change here is one MapLibre applies without reprocessing the loaded
// tiles: feature-state flags and constant paint values. Changing a filter or
// a data-driven paint expression instead reprocesses every loaded tile on
// each hover, which lagged — and briefly emptied queryRenderedFeatures, so a
// 1px mouse move cleared the highlight, which reprocessed the tiles again…
// (flicker).

// Feature-state flag on the highlighted lines, keyed by line id: promoteId
// in app.js makes route_id the id of `lines` features, and a stop feature's
// line ("id") the id of `stops` features — so one flag per line also marks
// all its stops.
const HIGHLIGHTED = ["boolean", ["feature-state", "highlight"], false];

// Faded = pale color rather than lower opacity: overlapping semi-transparent
// lines (a bus corridor, a line's two directions) add back up to look
// opaque, a pale color doesn't.
const FADED_SHARE = 0.4;  // share of the original color kept when faded

// Color mixed with white, keeping `share` of it.
function paleColor(hex, share) {
  const channels = hex.match(/\w\w/g).map(c => Math.round(255 - (255 - parseInt(c, 16)) * share));
  return "#" + channels.map(c => c.toString(16).padStart(2, "0")).join("");
}
const fade = color => paleColor(color, FADED_SHARE);

// Pale copies of the base layers, drawn all the time but transparent until
// something is highlighted; fading then swaps the opacities of the base layer
// and its copy (see BASE_OPACITY).
const LINES_FADED_LAYER = {
  ...LINES_LAYER,
  id: "lines-faded",
  paint: { ...LINES_LAYER.paint, "line-color": lineColor(fade), "line-opacity": 0 },
};
const STOPS_FADED_LAYER = {
  ...STOPS_LAYER,
  id: "stops-faded",
  paint: {
    ...STOPS_LAYER.paint,
    "circle-color": stopColor(fade),
    "circle-opacity": 0,
    "circle-stroke-opacity": 0,
  },
};

// Highlighted lines and their stops, redrawn on top of the faded ones in full
// color (a single layer can't draw some of its features last).
const LINES_HIGHLIGHT_LAYER = {
  ...LINES_LAYER,
  id: "lines-highlight",
  paint: {
    ...LINES_LAYER.paint,
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 12, 6],
    "line-opacity": ["case", HIGHLIGHTED, 1, 0],
  },
};
const STOPS_HIGHLIGHT_LAYER = {
  ...STOPS_LAYER,
  id: "stops-highlight",
  paint: {
    ...STOPS_LAYER.paint,
    "circle-opacity": ["case", HIGHLIGHTED, STOPS_LAYER.paint["circle-opacity"], 0],
    "circle-stroke-opacity": ["case", HIGHLIGHTED, 1, 0],
  },
};

// The hovered stop itself: its few features copied into a small GeoJSON
// source, drawn larger with a thicker white outline.
const HOVERED_STOP_LAYER = {
  id: "hovered-stop",
  type: "circle",
  source: "hovered-stop",
  paint: {
    "circle-color": stopColor(),
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 11, 7.5, 14, 11],
    "circle-stroke-width": 2,
    "circle-stroke-color": "#ffffff",
  },
};

// Copies of the base layers: they must follow the base layers' filters,
// visibility and zoom range (see app.js).
const LINES_COPY_IDS = [LINES_FADED_LAYER.id, LINES_HIGHLIGHT_LAYER.id];
const STOPS_COPY_IDS = [STOPS_FADED_LAYER.id, STOPS_HIGHLIGHT_LAYER.id];

// Base layer opacities (normal, faded) and their copies' (normal, faded).
const BASE_OPACITY = [
  ["lines", "line-opacity", LINES_LAYER.paint["line-opacity"]],
  ["stops", "circle-opacity", STOPS_LAYER.paint["circle-opacity"]],
  ["stops", "circle-stroke-opacity", 1],
];
const FADED_COPY = { lines: LINES_FADED_LAYER.id, stops: STOPS_FADED_LAYER.id };

function addHighlightLayers(beforeId) {
  map.addSource("hovered-stop", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // Above their base layer, in this order.
  map.addLayer(LINES_FADED_LAYER, "stops");
  map.addLayer(LINES_HIGHLIGHT_LAYER, "stops");
  map.addLayer(STOPS_FADED_LAYER, beforeId);
  map.addLayer(STOPS_HIGHLIGHT_LAYER, beforeId);
  map.addLayer(HOVERED_STOP_LAYER, beforeId);
}

function setFaded(faded) {
  for (const [layer, property, opacity] of BASE_OPACITY) {
    map.setPaintProperty(layer, property, faded ? 0 : opacity);
    map.setPaintProperty(FADED_COPY[layer], property, faded ? opacity : 0);
  }
}

// Highlight the given lines (route_id) and hovered stop features; [] and []
// clear it.
let highlighted = { lineIds: [], key: "" };
function setHighlight(lineIds, stopFeatures) {
  lineIds = [...new Set(lineIds)];
  const key = JSON.stringify([lineIds, stopFeatures.map(f => f.properties.stop_id)]);
  if (key === highlighted.key) return;

  for (const sourceLayer of ["lines", "stops"]) {
    for (const id of highlighted.lineIds) {
      map.removeFeatureState({ source: "transports", sourceLayer, id }, "highlight");
    }
    for (const id of lineIds) {
      map.setFeatureState({ source: "transports", sourceLayer, id }, { highlight: true });
    }
  }
  map.getSource("hovered-stop").setData({
    type: "FeatureCollection",
    features: stopFeatures.map(f => ({ type: "Feature", geometry: f.geometry, properties: f.properties })),
  });
  if ((lineIds.length > 0) !== (highlighted.lineIds.length > 0)) setFaded(lineIds.length > 0);
  highlighted = { lineIds, key };
}
