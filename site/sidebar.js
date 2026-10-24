// Filter panel: accessibility, city and per-mode line filters, their state,
// and how they filter the map's layers.
// Uses: map, MODE_COLORS, ACCESS_COLORS, ACCESS_LABELS (app.js);
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

// Text folded for search: case and accents ignored, hyphens and apostrophes
// read as spaces — "l hay" finds "L'Haÿ-les-Roses".
const foldForSearch = text => text.normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[-'’]/g, " ");

// ── State ────────────────────────────────────────────────────────────────────
let LINES = [];  // records from lines.json
let CITY_LABELS = {};  // INSEE code → "Name (département)", from lines.json
const accessState = { ...ACCESS_DEFAULT };
const selectedCities = new Set();  // INSEE codes
let cityFilterActive = false;  // whether modes were switched to all lines for it
const modeState = Object.fromEntries(Object.keys(MODE_COLORS).map(mode => [
  mode,
  { showAll: MODE_DEFAULT_ON.has(mode), lines: new Set() },
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
    if (!st) continue;
    if (!st.showAll && st.lines.size === 0) continue;
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
// Close any open dropdown when clicking outside of it, or on Escape.
document.addEventListener("click", e => {
  if (!e.target.closest(".dropdown")) closeAllDropdowns();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeAllDropdowns();
});

// A closed-by-default dropdown of checkboxes (search box included above
// SEARCH_THRESHOLD options), mirroring a Streamlit multiselect: the toggle
// shows the current selection, the panel opens on click and stays open
// while checking options, and closes on an outside click. Options are
// shown as labelOf(value); the search matches anywhere in them, or only at
// the start of a word with wordStart ("cre" finds Créteil, not Vaucresson).
// Without any option, the toggle shows emptyText and can't be opened.
function makeDropdown(container, values, selectionSet, onChange,
                      { labelOf = value => value, wordStart = false,
                        emptyText = "Aucun choix" } = {}) {
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
    const selected = values.filter(v => selectionSet.has(v)).map(labelOf);
    const text = values.length === 0 ? emptyText
      : selected.length === 0 ? "Sélectionner…"
      : selected.length <= 3 ? selected.join(", ")
      : `${selected.length} sélectionnées`;
    toggle.textContent = text;
    toggle.classList.toggle("placeholder", selected.length === 0);
  }
  toggle.disabled = values.length === 0;

  const panel = document.createElement("div");
  panel.className = "dropdown-panel";

  // A close button in the panel's top-right corner: the panel stays open
  // while ticking options, and clicking outside to close it isn't obvious.
  const close = document.createElement("button");
  close.type = "button";
  close.className = "dropdown-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Fermer");  // for screen readers
  close.addEventListener("click", () => {
    dropdown.classList.remove("open");
    toggle.focus();
  });
  panel.appendChild(close);
  let search = null;
  if (values.length > SEARCH_THRESHOLD) {
    search = document.createElement("input");
    search.className = "search";
    search.placeholder = "Rechercher…";
    panel.appendChild(search);
  }
  const list = document.createElement("div");
  list.className = "options";
  const noResults = document.createElement("div");
  noResults.className = "no-results";
  noResults.textContent = "Aucun résultat";
  noResults.hidden = true;
  const options = [];  // [label element, its text folded for search]
  function showMatchingOptions() {
    const query = foldForSearch(search.value).trim();
    let anyFound = false;
    for (const [label, text] of options) {
      const found = wordStart ? ` ${text}`.includes(` ${query}`) : text.includes(query);
      label.style.display = found ? "" : "none";
      anyFound ||= found;
    }
    noResults.hidden = anyFound;
  }
  for (const value of values) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = selectionSet.has(value);
    box.addEventListener("change", () => {
      box.checked ? selectionSet.add(value) : selectionSet.delete(value);
      updateToggleText();
      onChange();
      // An option found by searching is done with: clear the search, back
      // to the whole list, ready to type the next one. Only after a search,
      // so a phone's keyboard, already open then, never pops up on a tap.
      if (search?.value) {
        search.value = "";
        showMatchingOptions();
        search.focus();
      }
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(" " + labelOf(value)));
    list.appendChild(label);
    options.push([label, foldForSearch(labelOf(value))]);
  }
  panel.appendChild(list);
  panel.appendChild(noResults);
  search?.addEventListener("input", showMatchingOptions);

  updateToggleText();
  dropdown.appendChild(toggle);
  dropdown.appendChild(panel);
  container.appendChild(dropdown);
}

// Direct references to each mode's option containers (mode names contain
// spaces/accents, so they are not safe to use as DOM ids).
const modeUI = {};  // mode → { allBox, linesDiv }

// A specific line selection means "toutes les lignes" is no longer
// literally true — uncheck it (state + UI) so the checkbox never lies about
// what's actually shown.
function syncShowAllCheckbox(mode) {
  const st = modeState[mode];
  if (st.lines.size > 0 && st.showAll) {
    st.showAll = false;
    modeUI[mode].allBox.checked = false;
  }
}

// Selecting a city asks what serves it: every mode then shows all its
// lines, buses included (off by default only to keep the whole-region view
// readable); clearing the last city restores the defaults. Modes narrowed
// to specific lines are left alone, and the checkboxes show the change.
function onCitiesChange() {
  for (const mode of Object.keys(MODE_COLORS)) rebuildModeOptions(mode);
  const active = selectedCities.size > 0;
  if (active !== cityFilterActive) {
    cityFilterActive = active;
    for (const [mode, st] of Object.entries(modeState)) {
      if (st.lines.size > 0) continue;
      st.showAll = active || MODE_DEFAULT_ON.has(mode);
      modeUI[mode].allBox.checked = st.showAll;
    }
  }
  applyFilters();
}

// Rebuild the line list of one mode, pruning selections to the currently
// available options — like Streamlit multiselects.
function rebuildModeOptions(mode) {
  const st = modeState[mode];
  const names = [...new Set(availableLines(mode).map(l => l.route_long_name))]
    .sort(collator.compare);
  for (const name of st.lines) if (!names.includes(name)) st.lines.delete(name);
  makeDropdown(modeUI[mode].linesDiv, names, st.lines, () => {
    syncShowAllCheckbox(mode);
    applyFilters();
  }, { emptyText: "Aucune ligne correspondante" });
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

  const cityCodes = Object.keys(CITY_LABELS)
    .sort((a, b) => collator.compare(CITY_LABELS[a], CITY_LABELS[b]));
  makeDropdown(document.getElementById("cities"), cityCodes, selectedCities, onCitiesChange,
    { labelOf: code => CITY_LABELS[code], wordStart: true });

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
        rebuildModeOptions(mode);
      }
      applyFilters();
    });
    allLabel.appendChild(allBox);
    allLabel.appendChild(document.createTextNode(" Afficher toutes les lignes"));
    details.appendChild(allLabel);
    modeUI[mode].allBox = allBox;

    details.insertAdjacentHTML("beforeend", '<div class="hint">Sélectionnez des lignes spécifiques</div>');
    modeUI[mode].linesDiv = details.appendChild(document.createElement("div"));
    modesDiv.appendChild(details);
  }
  for (const mode of Object.keys(MODE_COLORS)) rebuildModeOptions(mode);
}
