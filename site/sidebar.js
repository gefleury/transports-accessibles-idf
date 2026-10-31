// Filter panel: accessibility, city and per-mode line filters, their state,
// and how they filter the map's layers.
// Uses: map, HOME_VIEW, stopsMinzoom, MODE_COLORS, ACCESS_COLORS, ACCESS_LABELS (app.js);
// LINES_COPY_IDS, STOPS_COPY_IDS (highlight.js); updateMapNotice,
// selectionActive, clearSelection (popup.js).

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
  `Une ligne n'est proposée que si au moins ${MIN_MATCHING_STOPS} de ses arrêts ` +
  "correspondent à l'accessibilité choisie (pour pouvoir monter et descendre).";
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

// Text folded for search: case and accents ignored, hyphens and apostrophes
// read as spaces — "l hay" finds "L'Haÿ-les-Roses".
const foldForSearch = text => text.normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[-'’]/g, " ");
// Whether a folded text has a word starting with a folded query: "cre"
// finds Créteil, not Vaucresson.
const startsAWord = (text, query) => ` ${text}`.includes(` ${query}`);

// ── State ────────────────────────────────────────────────────────────────────
let LINES = [];  // records from lines.json
let CITY_LABELS = {};  // INSEE code → "Name (département)", from lines.json
let CITY_BBOXES = {};  // INSEE code → its stops' bounding box, from lines.json
const accessState = { ...ACCESS_DEFAULT };
const selectedCities = new Set();  // INSEE codes
let cityFilterActive = false;  // whether modes were switched on for it
// A mode on shows its picked lines, or all of them if none is picked.
const modeState = Object.fromEntries(Object.keys(MODE_COLORS).map(mode => [
  mode,
  { on: MODE_DEFAULT_ON.has(mode), lines: new Set() },
]));

const selectedAccess = () => Object.keys(accessState).filter(k => accessState[k]);

// ── Filtering logic (mirrors apply_filters in the Streamlit app) ─────────────
function lineMatchesAccess(line, access) {
  // Mirror the stops layer: no accessibility criteria selected → nothing matches.
  if (access.length === 0) return false;
  const matchingStops = access.reduce((sum, k) => sum + line[ACCESS_COUNT_FIELD[k]], 0);
  return matchingStops >= MIN_MATCHING_STOPS;
}

// A line serves a city when it has a stop there matching the selected
// accessibility — one stop to board or alight there; it must serve every
// selected city (none selected → any line).
function lineServesCities(line, access, cities = selectedCities) {
  return [...cities].every(code => access.some(k => line.cities[code]?.[k] > 0));
}

function lineMatchesFilters(line, access) {
  return lineMatchesAccess(line, access) && lineServesCities(line, access);
}

// Line options offered in a mode's list: filtered by accessibility and
// cities — the map filter then works on selections pruned to these options.
function availableLines(mode) {
  const access = selectedAccess();
  return LINES.filter(l => l.mode === mode && lineMatchesFilters(l, access));
}

function visibleRouteIds() {
  const access = selectedAccess();
  const ids = [];
  for (const line of LINES) {
    const st = modeState[line.mode];
    if (!st?.on) continue;
    if (!lineMatchesFilters(line, access)) continue;
    if (st.lines.size > 0 && !st.lines.has(line.route_long_name)) continue;
    ids.push(line.route_id);
  }
  return ids;
}

function applyFilters() {
  // A filter change is a new view of the map: drop any selection, which
  // could otherwise stay highlighted (with its popup and "Revenir à la vue
  // d'ensemble" button) although its line is no longer shown.
  if (selectionActive) clearSelection();
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
  syncResetButton();
}

let shownLineCount = 0;

function updateStats() {
  document.getElementById("stats").textContent = `${shownLineCount} ligne(s) affichée(s)`;
  updateMapNotice();  // its zoom hint depends on the same state
}
map.on("zoomend", updateStats);

// ── Sidebar widgets ──────────────────────────────────────────────────────────

function closeAllDropdowns() {
  document.querySelectorAll(".dropdown.open").forEach(d => d.classList.remove("open"));
}
// Close any open dropdown when clicking outside of it, or on Escape. The
// event's path, not e.target.closest(): a click on an option or a tag's ×
// removes it from the page before this runs.
document.addEventListener("click", e => {
  if (!e.composedPath().some(el => el.classList?.contains("dropdown"))) closeAllDropdowns();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeAllDropdowns();
});

// A multiselect, like Streamlit's: a box showing the selected values as
// tags (each removable with its ×), or placeholder while there's none;
// clicking it opens the list of the other values, clicking one adds it.
// Lists longer than SEARCH_THRESHOLD can be typed into: the box is then
// also a search field narrowing the list. Shorter lists are click-only, so
// a phone's keyboard doesn't pop up for nothing. With the keyboard, ↓/↑
// move a highlight through the list and Enter picks the highlighted value
// (the first one until moved). The search matches anywhere in a value, or
// only at the start of a word with wordStart ("cre" finds Créteil, not
// Vaucresson); values starting with the query come first ("paris": Paris
// before Cormeilles-en-Parisis). Values are shown as labelOf(value). The list
// stays open after a pick, to pick several values seen in it, or closes
// with closeOnPick, for values searched one at a time (cities). A
// separator (HTML), if any, is shown between tags.
function makeMultiSelect(container, values, selectionSet, onChange,
                         { placeholder, labelOf = value => value, wordStart = false,
                           closeOnPick = false, separator = null }) {
  const folded = new Map(values.map(value => [value, foldForSearch(labelOf(value))]));
  const matches = wordStart ? startsAWord : (text, query) => text.includes(query);

  // The panel's × in its top-right corner: the panel stays open while
  // picking values, and clicking outside to close it isn't obvious.
  container.innerHTML =
    '<div class="dropdown"><div class="multiselect-box"><span class="tags"></span></div>' +
    '<div class="dropdown-panel">' +
    '<button type="button" class="dropdown-close" aria-label="Fermer">×</button>' +
    '<div class="options"></div></div></div>';
  const dropdown = container.firstChild;
  const box = dropdown.querySelector(".multiselect-box");
  const tags = box.querySelector(".tags");
  const list = dropdown.querySelector(".options");

  let input = null;
  const empty = document.createElement("span");  // click-only lists' placeholder
  if (values.length > SEARCH_THRESHOLD) {
    input = document.createElement("input");
    input.className = "multiselect-input";
    input.setAttribute("aria-label", placeholder);
    input.addEventListener("input", () => {
      active = 0;  // the best match, first
      setOpen(true);
    });
    box.appendChild(input);
  } else {
    empty.className = "multiselect-placeholder";
    empty.textContent = placeholder;
    box.appendChild(empty);
    box.tabIndex = 0;  // keyboard access, as a button
    box.setAttribute("role", "button");
  }

  // A phone's on-screen Enter key sends the same Enter, picking the
  // highlighted value; it has no arrows. On click-only lists (a button),
  // Enter or Space opens and closes the list.
  box.addEventListener("keydown", e => {
    const open = dropdown.classList.contains("open");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();  // no caret move or page scroll
      if (open) setActive(active + (e.key === "ArrowDown" ? 1 : -1));
      else setOpen(true);
    } else if (e.key === "Enter" && open && shown.length) {
      e.preventDefault();
      pick(shown[active], true);
    } else if (!input && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(!open);
    }
  });

  function setOpen(open) {
    if (open && !dropdown.classList.contains("open")) {
      closeAllDropdowns();
      active = 0;
    }
    dropdown.classList.toggle("open", open);
    if (open) showOptions();
  }
  box.addEventListener("click", e => {
    if (e.target.closest(".tag")) return;  // its × handles the click
    const open = dropdown.classList.contains("open");
    if (open && e.target === input) return;  // placing the caret
    setOpen(!open);
    if (!open) input?.focus();
  });
  dropdown.querySelector(".dropdown-close").addEventListener("click", () => {
    setOpen(false);
    (input ?? box).focus();
  });

  function change(value, selected) {
    selected ? selectionSet.add(value) : selectionSet.delete(value);
    showTags();
    showOptions();
    onChange();
  }

  function showTags() {
    const selected = values.filter(value => selectionSet.has(value)).map(value => {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = labelOf(value);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Retirer ${labelOf(value)}`);
      remove.addEventListener("click", () => change(value, false));
      tag.appendChild(remove);
      return tag;
    });
    // Separators are elements of their own, not drawn by CSS around the
    // tags, so they wrap with them.
    tags.replaceChildren(...selected.flatMap((tag, i) => {
      if (i === 0 || !separator) return [tag];
      const sign = document.createElement("span");
      sign.className = "tag-separator";
      sign.innerHTML = separator;
      sign.setAttribute("aria-hidden", "true");
      return [sign, tag];
    }));
    if (input) input.placeholder = selectionSet.size ? "Ajouter…" : placeholder;
    empty.hidden = selectionSet.size > 0;
  }

  let shown = [];  // values listed, in order
  let active = 0;  // index in shown of the highlighted value, Enter's pick
  function showOptions() {
    const query = input ? foldForSearch(input.value).trim() : "";
    const found = values.filter(value => !selectionSet.has(value) && matches(folded.get(value), query));
    const startsWithQuery = value => folded.get(value).startsWith(query);
    const ranked = [...found.filter(startsWithQuery), ...found.filter(v => !startsWithQuery(v))];
    shown = ranked;
    list.replaceChildren(...ranked.map((value, i) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "option";
      option.textContent = labelOf(value);
      option.addEventListener("click", () => pick(value));
      // mousemove, not mouseenter: the list scrolling under a still mouse
      // (arrow keys) mustn't take the highlight.
      option.addEventListener("mousemove", () => setActive(i));
      return option;
    }));
    if (!ranked.length) {
      list.innerHTML = `<div class="no-results">${query ? "Aucun résultat" : "Tout est sélectionné"}</div>`;
    }
    setActive(active);  // kept in place after a pick: the next value
  }

  function setActive(i) {
    const options = list.querySelectorAll(".option");
    if (!options.length) return;
    active = Math.max(0, Math.min(i, options.length - 1));
    options.forEach((option, j) => option.classList.toggle("active", j === active));
    options[active].scrollIntoView({ block: "nearest" });
  }

  // A value found by typing is done with: clear the search. Then, keep the
  // focus to go on with the keyboard when picked with Enter, or after
  // typing in a list staying open (a phone's keyboard is then already open,
  // so it never pops up on a tap); else let it go, putting a phone's
  // keyboard away to show the map.
  function pick(value, withEnter = false) {
    const typed = Boolean(input?.value);
    if (input) input.value = "";
    if (closeOnPick) setOpen(false);
    if (withEnter || (typed && !closeOnPick)) (input ?? box).focus();
    else input?.blur();
    change(value, true);
  }

  showTags();
}

// ── Filter panel ─────────────────────────────────────────────────────────────
// One section per filter: build* creates its widgets once, from the state;
// what redraws them is shared by the user's changes and the reset.

// Accessibility ──

const accessBoxes = {};  // status → its checkbox

function buildAccessFilter() {
  const accessDiv = document.getElementById("access");
  for (const [key, color] of Object.entries(ACCESS_COLORS)) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = accessState[key];
    box.addEventListener("change", () => {
      accessState[key] = box.checked;
      rebuildAllModeOptions();
      applyFilters();
    });
    label.appendChild(box);
    label.insertAdjacentHTML("beforeend",
      ` <span class="swatch" style="background:${color}"></span> ${ACCESS_LABELS[key]}`);
    accessDiv.appendChild(label);
    accessBoxes[key] = box;
  }
}

// Cities ──

// (Re)draws the city filter from selectedCities. Cities match from the
// start of a word, as typing is the way in (~1,300).
function buildCityFilter() {
  const cityCodes = Object.keys(CITY_LABELS)
    .sort((a, b) => collator.compare(CITY_LABELS[a], CITY_LABELS[b]));
  makeMultiSelect(document.getElementById("cities"), cityCodes, selectedCities, onCitiesChange, {
    placeholder: "Filtrer par ville (toutes par défaut)",
    labelOf: code => CITY_LABELS[code],
    wordStart: true,
    closeOnPick: true,
    // Cities combine with "and" (a line must serve them all), unlike lines
    // ("or"): a double arrow between them shows the lines connecting them.
    // An icon, not the "↔" character: its look depends on the fonts, and
    // some lack it.
    separator: '<svg width="14" height="9"><use href="#icon-both-ways" /></svg>',
  });
}

// Selecting a city asks what serves it: every mode is then switched on,
// buses included (off by default only to keep the whole-region view
// readable). Clearing the last city returns to the overview, as the hint
// says — lines picked from a city's list make no sense without it. The
// checkboxes show the change.
function onCitiesChange() {
  const active = selectedCities.size > 0;
  if (active !== cityFilterActive) {
    cityFilterActive = active;
    if (active) for (const st of Object.values(modeState)) st.on = true;
    else resetModes();
  }
  rebuildAllModeOptions();
  applyFilters();
  zoomToCities();
}

// TER lines run far beyond Île-de-France (Normandy, the Loire valley):
// framing them would zoom the map far out.
const ZOOM_EXCLUDED_MODES = new Set(["TER"]);

// The box ([west, south, east, north]) enclosing all the given ones.
function unionBox(boxes) {
  return boxes.reduce((a, b) => [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3]),
  ]);
}

// Frame the map on the lines serving the selected cities — where one can
// go from there, not just the cities — or back to the initial view without
// any. TER lines stay shown, just left out of the framing, unless they're
// all there is. Without any shown line (e.g. only stops of an accessibility
// left unticked), the cities themselves: ticking it then shows their lines
// in place. Never zoomed out so far that stops disappear (stopsMinzoom), as
// a city's network can need on a phone, or for a big city: then centered on
// the cities. Only city changes move the map — a zoom on every click tires.
function zoomToCities() {
  if (selectedCities.size === 0) {
    map.easeTo(HOME_VIEW);
    return;
  }
  const cities = unionBox([...selectedCities].map(code => CITY_BBOXES[code]));
  const shown = new Set(visibleRouteIds());
  const lines = LINES.filter(l => shown.has(l.route_id));
  const framed = lines.filter(l => !ZOOM_EXCLUDED_MODES.has(l.mode));
  const boxes = (framed.length ? framed : lines).map(l => l.bbox);
  const [west, south, east, north] = boxes.length ? unionBox(boxes) : cities;
  const camera = map.cameraForBounds([[west, south], [east, north]], { padding: 40, maxZoom: 14 });
  if (camera.zoom < stopsMinzoom) {
    camera.zoom = stopsMinzoom;
    camera.center = [(cities[0] + cities[2]) / 2, (cities[1] + cities[3]) / 2];
  }
  map.easeTo(camera);
}

// Modes and their lines ──

// Direct references to each mode's row elements (mode names contain
// spaces/accents, so they are not safe to use as DOM ids).
const modeUI = {};  // mode → { row, box, linesDiv }

// One row per mode: its checkbox, then its line list when it's on.
function buildModeRows() {
  const modesDiv = document.getElementById("modes");
  for (const [mode, color] of Object.entries(MODE_COLORS)) {
    const row = document.createElement("div");
    row.className = "mode";
    row.innerHTML =
      `<label class="mode-toggle"><input type="checkbox"><span class="mode-name">${mode}</span>` +
      `<span class="bar" style="background:${color}"></span></label>` +
      '<div class="mode-lines"></div>' +
      '<div class="hint mode-empty">Aucune ligne correspondante</div>';
    const box = row.querySelector("input");
    box.addEventListener("change", () => {
      modeState[mode].on = box.checked;
      syncModeRow(mode);
      applyFilters();
    });
    modeUI[mode] = { row, box, linesDiv: row.querySelector(".mode-lines") };
    modesDiv.appendChild(row);
  }
}

// Show a mode's row as its state: ticked with its line list when on; greyed
// out, with "Aucune ligne correspondante", when no line matches the filters
// (its state is kept for when the filters change again).
function syncModeRow(mode) {
  const { row, box } = modeUI[mode];
  box.checked = modeState[mode].on && !box.disabled;
  row.classList.toggle("on", box.checked);
}

// Rebuild the line list of one mode, pruning selections to the currently
// available options — like Streamlit multiselects.
function rebuildModeOptions(mode) {
  const st = modeState[mode];
  const names = [...new Set(availableLines(mode).map(l => l.route_long_name))]
    .sort(collator.compare);
  for (const name of st.lines) if (!names.includes(name)) st.lines.delete(name);
  makeMultiSelect(modeUI[mode].linesDiv, names, st.lines, applyFilters,
    { placeholder: "Filtrer par ligne (toutes par défaut)" });
  modeUI[mode].row.classList.toggle("empty", names.length === 0);
  modeUI[mode].box.disabled = names.length === 0;
  syncModeRow(mode);
}

// Every mode's line list follows the accessibility and city filters.
function rebuildAllModeOptions() {
  for (const mode of Object.keys(MODE_COLORS)) rebuildModeOptions(mode);
}

// Reset ──

// The overview's modes: the default ones, no line picked.
function resetModes() {
  for (const [mode, st] of Object.entries(modeState)) {
    st.on = MODE_DEFAULT_ON.has(mode);
    st.lines.clear();
  }
}

function filtersAtDefault() {
  return Object.entries(ACCESS_DEFAULT).every(([key, on]) => accessState[key] === on)
    && selectedCities.size === 0
    && Object.entries(modeState).every(([mode, st]) =>
      st.on === MODE_DEFAULT_ON.has(mode) && st.lines.size === 0);
}

// "Réinitialiser tous les filtres", at the bottom of the panel: shown only once a
// filter differs from the default view (applyFilters keeps it in sync).
function syncResetButton() {
  document.getElementById("reset-filters").hidden = filtersAtDefault();
}

function resetFilters() {
  const hadCities = selectedCities.size > 0;
  Object.assign(accessState, ACCESS_DEFAULT);
  for (const [key, box] of Object.entries(accessBoxes)) box.checked = accessState[key];
  selectedCities.clear();
  cityFilterActive = false;
  buildCityFilter();
  resetModes();
  rebuildAllModeOptions();
  applyFilters();
  if (hadCities) zoomToCities();  // back home, as on removing the last city
}

// ── Page loading ─────────────────────────────────────────────────────────────

function buildSidebar() {
  buildAccessFilter();
  buildCityFilter();
  buildModeRows();
  rebuildAllModeOptions();
  document.getElementById("reset-filters").addEventListener("click", resetFilters);
}
