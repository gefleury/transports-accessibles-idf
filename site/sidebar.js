// Filter panel: accessibility and per-mode line filters, their state, and
// how they filter the map's layers.
// Uses: map, MODE_COLORS, ACCESS_COLORS, ACCESS_LABELS (app.js);
// LINES_COPY_IDS, STOPS_COPY_IDS (highlight.js); updateMapNotice (popup.js).

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
map.on("zoomend", updateStats);

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
