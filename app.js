/* A Scow Rig Tuning — log & config editor.
   Pure client-side, localStorage-backed. No build step. */
"use strict";

const STORE_KEY = "ascow-tuning/v1";
// Display order top-of-mast down. North Sails naming: the masthead wire
// (data key "intermediates") is "Uppers"; the upper-spreader wire (data key
// "uppers") is "Intermediates". Data keys are unchanged so logged numbers and
// Loos wire sizes stay correct — only the labels/order differ.
const WIRE_KEYS = ["intermediates", "uppers", "lowers", "forestay"];
const WIRE_LABELS = {
  intermediates: "Uppers",
  uppers: "Intermediates",
  lowers: "Lowers",
  forestay: "Forestay (rake, in)"
};

/* ---------- utilities ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => (v === "" || v == null || isNaN(parseFloat(v)) ? null : parseFloat(v));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

/* ---------- persistence ---------- */
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
  } catch (e) { console.warn("load failed", e); }
  return seedState();
}

// Ensure every profile's config has the nested shapes the UI writes into.
// Strip personal attribution (names, dates, transcription notes) from a config,
// keeping the tuning data and public references (e.g. the North Sails guide).
function scrubAttribution(c) {
  if (c.meta) { delete c.meta.source; delete c.meta.sourceDate; delete c.meta.transcribedFrom; }
  if (c.hull) delete c.hull.source;
  if (Array.isArray(c.validations)) {
    for (const v of c.validations) {
      delete v.source;
      if (v.note) v.note = v.note.replace(/transcribed data/gi, "Data").replace(/\s*against the original card/gi, "");
    }
  }
  if (c.prebend && c.prebend.source) {
    c.prebend.source = c.prebend.source.replace(/replace with [^)]*targets/gi, "replace with your measured targets");
  }
  for (const s of (c.setups || [])) {
    const cells = [s.base || {}, ...Object.values(s.byWind || {})];
    for (const cell of cells) {
      for (const wire of Object.values(cell || {})) {
        if (wire && wire.verifyNote) wire.verifyNote = wire.verifyNote.replace(/original card/gi, "your source");
      }
    }
  }
}

function normalizeState(st) {
  if (!st || !Array.isArray(st.profiles)) return seedState();
  for (const p of st.profiles) {
    const c = (p.config = p.config || clone(REFERENCE_DATA));
    c.meta = c.meta || {};
    // terminology is static reference text (not user-editable) — keep it in sync
    // with the current naming convention so existing profiles update too.
    c.terminology = clone(REFERENCE_DATA.terminology);
    c.windRanges = c.windRanges && c.windRanges.length ? c.windRanges : clone(REFERENCE_DATA.windRanges);
    c.setups = Array.isArray(c.setups) ? c.setups : [];
    c.hull = c.hull || clone(REFERENCE_DATA.hull);
    c.prebend = c.prebend || clone(REFERENCE_DATA.prebend);
    c.prebend.byBand = c.prebend.byBand || {};
    c.globalNotes = c.globalNotes || [];
    scrubAttribution(c);
    const pb = c.prebend.byBand || {};
    const bandBend = (band) => {
      const v = band === "light" ? pb.light : band === "heavy" ? pb.heavy : pb.allPurpose;
      return v == null ? "" : Array.isArray(v) ? v.join("–") : String(v);
    };
    for (const s of c.setups) {
      s.base = s.base || {};
      s.byWind = s.byWind || {};
      s.notes = s.notes || [];
      // migrate: seed the pre-bend/diamond row from the reference byBand if absent
      if (s.base.intermediates === undefined) s.base.intermediates = { in: bandBend("medium") };
      for (const r of c.windRanges) {
        s.byWind[r.id] = s.byWind[r.id] || {};
        if (s.byWind[r.id].intermediates === undefined) s.byWind[r.id].intermediates = { in: bandBend(r.band) };
      }
    }
    p.log = Array.isArray(p.log) ? p.log : [];
  }
  if (!st.profiles.some((p) => p.id === st.activeProfileId)) st.activeProfileId = st.profiles[0].id;

  // one-time: log entries recorded before the gauge feature hold raw PT-1 readings
  // in canonical (Model A) slots. Convert them once, and default this user to the
  // PT-1 gauge they actually use so the numbers read as originally written down.
  if (!st.logsGaugeMigrated) {
    let migrated = false;
    for (const p of st.profiles) {
      for (const entry of (p.log || [])) {
        const ps = entry.perSide; if (!ps) continue;
        for (const wireRow of ["uppers", "lowers", "intermediates"]) {
          const w = ps[wireRow]; if (!w) continue;
          for (const sideKey of ["port", "stbd"]) {
            const sd = w[sideKey];
            if (!sd || sd.loos === "" || sd.loos == null) continue;
            const conv = convertReading("PT-1", "Model A", WIRE_SIZE[wireRow], sd.loos);
            if (conv != null) { sd.loos = conv; migrated = true; }
          }
        }
      }
    }
    if (migrated) st.gauge = "PT-1";
    st.logsGaugeMigrated = true;
  }

  if (!GAUGES.includes(st.gauge)) st.gauge = "Model A";
  return st;
}

function seedState() {
  const id = uid();
  return {
    activeProfileId: id,
    gauge: "Model A",
    profiles: [makeProfile("Catapult IV", id)]
  };
}

/* ---------- gauge (Model A / PT-1) ---------- */
// Stored loos readings are canonical Model A; we convert to/from the active gauge
// for every display and input across the app. lbs is gauge-neutral and untouched.
function activeGauge() { return GAUGES.includes(state.gauge) ? state.gauge : "Model A"; }
function gaugeUnit() { return activeGauge(); }  // "Model A" or "PT-1"

// canonical Model A loos -> value shown in the active gauge
function loosToDisplay(wireRow, loos) {
  if (loos === "" || loos == null) return "";
  if (activeGauge() === "Model A") return loos;
  const v = convertReading("Model A", "PT-1", WIRE_SIZE[wireRow], loos);
  return v == null ? "" : v;
}
// value entered in the active gauge -> canonical Model A loos for storage
function loosToStore(wireRow, entered) {
  if (entered === "" || entered == null) return null;
  if (activeGauge() === "Model A") return num(entered);
  const v = convertReading("PT-1", "Model A", WIRE_SIZE[wireRow], entered);
  return v == null ? null : v;
}

function makeProfile(name, id) {
  const ref = clone(REFERENCE_DATA);
  ref.meta.boat = name;
  return {
    id: id || uid(),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: ref,   // editable copy of reference data
    log: []
  };
}

let savedFlashTimer = null;
function flashSaved() {
  const el = $("#savedFlash");
  if (!el) return;
  el.hidden = false;
  el.classList.add("show");
  clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => { el.classList.remove("show"); }, 1400);
}

function save() {
  const p = activeProfile();
  if (p) p.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    alert("Could not save to browser storage: " + e.message);
  }
  flashSaved();
  scheduleSync();
}

/* ---------- server sync (shared storage across clients) ---------- */
const SYNC_ENABLED = location.protocol === "http:" || location.protocol === "https:";
const API_URL = "/api/store";
let serverRev = null;
let syncTimer = null;

function setSyncStatus(s, title) {
  const el = $("#syncStatus");
  if (!el) return;
  if (!SYNC_ENABLED) { el.hidden = true; return; }
  el.hidden = false;
  el.className = "sync " + s;
  el.textContent = { synced: "Synced", saving: "Saving…", offline: "Offline" }[s] || s;
  if (title) el.title = title;
}

async function pullFromServer() {
  if (!SYNC_ENABLED) { setSyncStatus("offline", "Open via the server to sync across devices"); return false; }
  try {
    const r = await fetch(API_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    serverRev = j.rev;
    if (j.store && Array.isArray(j.store.profiles) && j.store.profiles.length) {
      state = normalizeState(j.store);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
      setSyncStatus("synced", "Loaded from server (rev " + serverRev + ")");
      return true;
    }
    // server empty — seed it from this client's local data
    await pushToServer();
    return false;
  } catch (e) {
    setSyncStatus("offline", "Server unreachable — using this device only");
    return false;
  }
}

function scheduleSync() {
  if (!SYNC_ENABLED) return;
  clearTimeout(syncTimer);
  setSyncStatus("saving");
  syncTimer = setTimeout(pushToServer, 600);
}

async function pushToServer() {
  if (!SYNC_ENABLED) return;
  try {
    const r = await fetch(API_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    serverRev = j.rev;
    setSyncStatus("synced", "Saved to server (rev " + serverRev + ")");
  } catch (e) {
    setSyncStatus("offline", "Save failed — kept on this device, will retry on next change");
  }
}

// Show the signed-in crew (via Cloudflare Access) + a logout link, if present.
async function showIdentity() {
  if (!SYNC_ENABLED) return;
  try {
    const r = await fetch("/cdn-cgi/access/get-identity", { cache: "no-store" });
    if (!r.ok) return;                 // Access not enabled -> nothing to show
    const id = await r.json();
    const who = id.email || id.name;
    if (!who) return;
    const el = $("#whoami");
    el.hidden = false;
    el.innerHTML = esc(who) + ' · <a href="/cdn-cgi/access/logout">log out</a>';
  } catch (e) { /* not behind Access */ }
}

function activeProfile() {
  return state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0];
}

// wind-band pill (Light=blue, Medium=yellow, Heavy=red)
const BAND_CLASS = { light: "band-light", medium: "band-medium", heavy: "band-heavy" };
function bandPill(band) {
  return `<span class="pill ${BAND_CLASS[band] || ""}">${esc(band)}</span>`;
}

/* ---------- tension cell helpers ---------- */
// Resolve a wind cell against base (handles sameAsBase).
function resolveCell(setup, rangeId, wire) {
  const cell = setup.byWind?.[rangeId]?.[wire];
  if (!cell) return { empty: true };
  if (cell.sameAsBase) {
    const base = setup.base?.[wire] || {};
    return { ...base, fromBase: true };
  }
  return cell;
}

function fmtVal(wire, v) {
  if (!v || v.empty) return '<span class="muted">—</span>';
  const parts = [];
  if (wire === "forestay") {
    if (v.in != null) parts.push(`<span class="cell-main">${v.in}"</span>`);
  } else if (wire === "intermediates") {
    if (v.in != null && v.in !== "") parts.push(`<span class="cell-main">${esc(v.in)}" bend</span>`);
    if (v.loos != null) parts.push(`<span class="cell-sub">${loosToDisplay(wire, v.loos)} ${gaugeUnit()}</span>`);
    if (v.lbs != null) parts.push(`<span class="cell-sub">${v.lbs} lbs</span>`);
  } else {
    if (v.loos != null) parts.push(`<span class="cell-main">${loosToDisplay(wire, v.loos)} ${gaugeUnit()}</span>`);
    if (v.lbs != null) parts.push(`<span class="cell-sub">${v.lbs} lbs</span>`);
  }
  if (v.turns != null) parts.push(`<span class="cell-turns">${v.turns > 0 ? "+" : ""}${v.turns}t</span>`);
  if (v.note) parts.push(`<span class="cell-sub">${esc(v.note)}</span>`);
  if (v.fromBase) parts.push(`<span class="cell-sub">(= base)</span>`);
  if (v.verify) parts.push(`<span class="warn-flag" title="${esc(v.verifyNote || "Flagged to verify")}">⚠ verify</span>`);
  if (!parts.length) return '<span class="muted">—</span>';
  return parts.join("<br>");
}

/* lowers ≈ 0.5 * intermediates validation; returns array of violation strings.
   (Compares the chainplate wire — data key "uppers", labeled "Intermediates" —
   against the lowers; the same two physical wires as before.) */
function validateSetup(setup, ranges) {
  const out = [];
  for (const r of ranges) {
    const up = resolveCell(setup, r.id, "uppers");
    const lo = resolveCell(setup, r.id, "lowers");
    if (up.lbs != null && lo.lbs != null) {
      const ideal = 0.5 * up.lbs;
      const ratio = lo.lbs / up.lbs;
      if (ratio < 0.38 || ratio > 0.62) {
        out.push(`${setup.label} @ ${r.id} kn: lowers ${lo.lbs} vs ½·intermediates ${Math.round(ideal)} (ratio ${(ratio).toFixed(2)})`);
      }
    }
  }
  return out;
}

/* ============================================================
   PROFILES
   ============================================================ */
function renderProfileSelect() {
  const sel = $("#profileSelect");
  sel.innerHTML = state.profiles
    .map((p) => `<option value="${p.id}" ${p.id === state.activeProfileId ? "selected" : ""}>${esc(p.name)}</option>`)
    .join("");
}

function setActiveProfile(id) {
  state.activeProfileId = id;
  save();
  renderAll();
}

function newProfile() {
  const name = prompt("Boat name for the new profile:", "");
  if (!name) return;
  const startBlank = state.profiles.length > 0 &&
    confirm("OK = start from the reference grid.\nCancel = copy the current boat's settings & wind/rig config (log not copied).");
  let p;
  if (startBlank) {
    p = makeProfile(name);
  } else {
    p = clone(activeProfile());
    p.id = uid();
    p.name = name;
    p.config.meta.boat = name;
    p.log = [];
    p.createdAt = p.updatedAt = new Date().toISOString();
  }
  state.profiles.push(p);
  state.activeProfileId = p.id;
  save();
  renderAll();
  toast("Created “" + name + "”");
}

function renameProfile() {
  const p = activeProfile();
  const name = prompt("Rename boat profile:", p.name);
  if (!name) return;
  p.name = name;
  p.config.meta.boat = name;
  save();
  renderAll();
}

function deleteProfile() {
  if (state.profiles.length <= 1) { alert("Can't delete the only profile. Create another first."); return; }
  const p = activeProfile();
  if (!confirm(`Delete profile “${p.name}” and its ${p.log.length} log entr${p.log.length === 1 ? "y" : "ies"}? This cannot be undone (export first to back up).`)) return;
  state.profiles = state.profiles.filter((x) => x.id !== p.id);
  state.activeProfileId = state.profiles[0].id;
  save();
  renderAll();
  toast("Deleted");
}

function exportProfile() {
  const p = activeProfile();
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safe = p.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  a.href = url;
  a.download = `ascow-tuning-${safe}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Exported " + a.download);
}

function importProfile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      const incoming = Array.isArray(obj) ? obj : (obj.profiles ? obj.profiles : [obj]);
      let count = 0;
      for (const raw of incoming) {
        if (!raw || !raw.config) continue;
        const p = clone(raw);
        p.id = uid();
        p.log = Array.isArray(p.log) ? p.log : [];
        if (state.profiles.some((x) => x.name === p.name)) p.name += " (imported)";
        state.profiles.push(p);
        state.activeProfileId = p.id;
        count++;
      }
      if (!count) { alert("No valid profiles found in that file."); return; }
      normalizeState(state);
      save();
      renderAll();
      toast(`Imported ${count} profile${count > 1 ? "s" : ""}`);
    } catch (e) {
      alert("Import failed: " + e.message);
    }
  };
  reader.readAsText(file);
}

/* ============================================================
   TUNING GRID
   ============================================================ */
let activeSetupId = null;

function renderGrid() {
  const cfg = activeProfile().config;
  const setups = cfg.setups;
  if (!setups.length) { $("#gridHost").innerHTML = '<p class="empty">No tunes. Add one.</p>'; $("#setupTabs").innerHTML = ""; $("#setupNotes").innerHTML = ""; return; }
  if (!setups.some((s) => s.id === activeSetupId)) activeSetupId = setups[0].id;

  // setup tabs + per-tune actions
  $("#setupTabs").innerHTML = setups
    .map((s) => `<button data-setup="${s.id}" class="${s.id === activeSetupId ? "active" : ""}">${esc(s.label)}</button>`)
    .join("") +
    `<span class="tab-actions">
       <button class="sm ghost" id="btnRenameSetup" title="Rename the selected tune">✎ Rename</button>
       <button class="sm ghost" id="btnDupSetup" title="Duplicate the selected tune">⧉ Duplicate</button>
     </span>`;

  const setup = setups.find((s) => s.id === activeSetupId);
  const ranges = cfg.windRanges;

  // warnings
  const viol = validateSetup(setup, ranges);
  $("#gridWarnings").innerHTML = viol.length
    ? `<div class="banner warn"><strong>Rule-of-thumb check (lowers ≈ ½ intermediates):</strong><ul class="notes-list">${viol.map((v) => `<li>${esc(v)}</li>`).join("")}</ul><span class="muted">Surfaced for verification — not auto-corrected.</span></div>`
    : "";

  // header row
  const rangeHead = ranges.map((r) => {
    const lo = r.knots[0], hi = r.knots[1];
    return `<th>${lo}–${hi} kn ${bandPill(r.band)}</th>`;
  }).join("");

  // body rows: one per wire + forestay + base column
  const rows = WIRE_KEYS.map((wire) => {
    const label = WIRE_LABELS[wire] || wire;
    const baseCell = `<td>${editCell(setup, "base", wire)}</td>`;
    const windCells = ranges.map((r) => `<td>${editCell(setup, r.id, wire)}</td>`).join("");
    return `<tr><th class="wire-col">${label}</th>${baseCell}${windCells}</tr>`;
  }).join("");

  $("#gridHost").innerHTML = `
    <table class="grid">
      <thead><tr><th class="wire-col">Wire</th><th>Base</th>${rangeHead}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint" style="margin-top:8px;">Editing: leave a field blank to clear it. Base column is the zero point for turns.</p>`;

  // setup notes
  renderSetupNotes(setup);
}

// Editable cell: shows inputs for the relevant fields.
function editCell(setup, where, wire) {
  const cell = where === "base"
    ? (setup.base[wire] = setup.base[wire] || {})
    : ((setup.byWind[where] = setup.byWind[where] || {}), (setup.byWind[where][wire] = setup.byWind[where][wire] || {}));
  const path = `${where}|${wire}`;
  const f = (k, ph) => `<label>${ph}<input data-cell="${path}" data-k="${k}" value="${cell[k] != null ? esc(cell[k]) : ""}" /></label>`;
  // loos shows in the active gauge (stored value is canonical Model A)
  const fLoos = () => `<label>${gaugeUnit()}<input data-cell="${path}" data-k="loos" value="${esc(loosToDisplay(wire, cell.loos))}" /></label>`;
  let inputs;
  if (wire === "forestay") {
    inputs = f("in", "in");
  } else if (wire === "intermediates") {
    inputs = f("in", "bend in") + fLoos() + f("lbs", "lbs") + (where !== "base" ? f("turns", "turns") : "");
  } else {
    inputs = fLoos() + f("lbs", "lbs") + (where !== "base" ? f("turns", "turns") : "");
  }
  // note + sameAsBase for wind cells
  let extra = "";
  if (where !== "base") {
    extra = `<label style="width:100%">note<input data-cell="${path}" data-k="note" value="${cell.note != null ? esc(cell.note) : ""}" style="width:100%"/></label>`;
  } else if (wire !== "forestay") {
    extra = `<label style="width:100%">note<input data-cell="${path}" data-k="note" value="${cell.note != null ? esc(cell.note) : ""}" style="width:100%"/></label>`;
  }
  const flag = cell.verify ? `<span class="warn-flag" title="${esc(cell.verifyNote || "verify")}">⚠</span>` : "";
  return `<div class="cell-edit">${inputs}${extra}${flag}</div>`;
}

function commitCellEdit(input) {
  const setup = activeProfile().config.setups.find((s) => s.id === activeSetupId);
  const [where, wire] = input.dataset.cell.split("|");
  const k = input.dataset.k;
  const target = where === "base" ? setup.base[wire] : setup.byWind[where][wire];
  const raw = input.value.trim();
  const isText = k === "note" || (wire === "intermediates" && k === "in");
  if (isText) {
    if (raw) target[k] = raw; else delete target[k];
  } else if (k === "loos") {
    const v = loosToStore(wire, raw);   // entered in active gauge -> canonical Model A
    if (v == null) delete target.loos; else target.loos = v;
  } else {
    const n = num(raw);
    if (n == null) delete target[k]; else target[k] = n;
  }
  // if a sameAsBase cell gets edited, drop the flag
  if (where !== "base" && target.sameAsBase && raw) delete target.sameAsBase;
  save();
  // brief green flash on the edited cell so it's clear the change stuck
  input.classList.remove("cell-saved");
  void input.offsetWidth;            // restart animation if re-edited quickly
  input.classList.add("cell-saved");
  setTimeout(() => input.classList.remove("cell-saved"), 900);
  // re-render warnings only (avoid losing focus on full re-render)
  const viol = validateSetup(setup, activeProfile().config.windRanges);
  $("#gridWarnings").innerHTML = viol.length
    ? `<div class="banner warn"><strong>Rule-of-thumb check (lowers ≈ ½ intermediates):</strong><ul class="notes-list">${viol.map((v) => `<li>${esc(v)}</li>`).join("")}</ul><span class="muted">Surfaced for verification — not auto-corrected.</span></div>`
    : "";
}

function renderSetupNotes(setup) {
  const notes = setup.notes || [];
  $("#setupNotes").innerHTML = `
    <div class="flex-between" style="margin-top:16px;">
      <h2 style="font-size:14px;margin:0;">${esc(setup.label)} — notes</h2>
      <div>
        <button class="sm" id="btnAddNote">+ Note</button>
        <button class="sm danger" id="btnDelSetup">Delete this tune</button>
      </div>
    </div>
    ${notes.length ? `<ul class="notes-list">${notes.map((n, i) => `<li>${esc(n)} <button class="sm ghost" data-delnote="${i}" title="remove">✕</button></li>`).join("")}</ul>` : '<p class="muted">No notes.</p>'}`;
}

function addSetup() {
  const label = prompt("Name for the new tune (e.g. a sailor or a season):", "");
  if (!label) return;
  const cfg = activeProfile().config;
  const setup = {
    id: uid(),
    label: label.trim(),
    base: { uppers: {}, lowers: {}, intermediates: {}, forestay: {} },
    byWind: {},
    notes: []
  };
  cfg.windRanges.forEach((r) => { setup.byWind[r.id] = { uppers: {}, lowers: {}, intermediates: {}, forestay: {} }; });
  cfg.setups.push(setup);
  activeSetupId = setup.id;
  save();
  renderGrid();
  renderLogControls();
}

function renameSetup() {
  const cfg = activeProfile().config;
  const setup = cfg.setups.find((s) => s.id === activeSetupId);
  if (!setup) return;
  const label = prompt("Rename tune:", setup.label);
  if (label == null) return;
  const name = label.trim();
  if (!name) return;
  setup.label = name;
  save();
  renderGrid();
  renderLogControls();
  toast("Renamed to " + name);
}

function duplicateSetup() {
  const cfg = activeProfile().config;
  const setup = cfg.setups.find((s) => s.id === activeSetupId);
  if (!setup) return;
  const label = prompt("Name for the duplicate:", setup.label + " copy");
  if (label == null) return;
  const name = label.trim() || setup.label + " copy";
  const copy = clone(setup);
  copy.id = uid();
  copy.label = name;
  const i = cfg.setups.findIndex((s) => s.id === activeSetupId);
  cfg.setups.splice(i + 1, 0, copy);
  activeSetupId = copy.id;
  save();
  renderGrid();
  renderLogControls();
  toast("Duplicated as " + name);
}

/* ============================================================
   LOG
   ============================================================ */
let editingLogId = null;

function rangeOptions(selected) {
  const cfg = activeProfile().config;
  return cfg.windRanges
    .map((r) => `<option value="${r.id}" ${r.id === selected ? "selected" : ""}>${r.knots[0]}–${r.knots[1]} kn (${r.band})</option>`)
    .join("");
}

function renderLogControls() {
  const cfg = activeProfile().config;
  $("#logRange").innerHTML = `<option value="">—</option>` + rangeOptions(null);
  // prefill: setup × range
  let opts = `<option value="">— none —</option>`;
  for (const s of cfg.setups) {
    for (const r of cfg.windRanges) {
      opts += `<option value="${s.id}::${r.id}">${esc(s.label)} @ ${r.knots[0]}–${r.knots[1]} kn</option>`;
    }
  }
  $("#logPrefill").innerHTML = opts;
}

function prefillFromSetup() {
  const v = $("#logPrefill").value;
  if (!v) return;
  const [sid, rid] = v.split("::");
  const cfg = activeProfile().config;
  const setup = cfg.setups.find((s) => s.id === sid);
  if (!setup) return;
  const up = resolveCell(setup, rid, "uppers");
  const lo = resolveCell(setup, rid, "lowers");
  const inter = resolveCell(setup, rid, "intermediates");
  const fs = resolveCell(setup, rid, "forestay");
  // reference grid is a single centerline value — seed both sides as a starting point
  const seedSide = (ref, wireRow, ids) => {
    const disp = loosToDisplay(wireRow, ref.loos);  // ref.loos is canonical Model A
    $("#" + ids[0]).value = disp;
    $("#" + ids[1]).value = ref.lbs ?? "";
    $("#" + ids[2]).value = disp;
    $("#" + ids[3]).value = ref.lbs ?? "";
  };
  seedSide(up, "uppers", ["upPortLoos", "upPortLbs", "upStbdLoos", "upStbdLbs"]);
  seedSide(lo, "lowers", ["loPortLoos", "loPortLbs", "loStbdLoos", "loStbdLbs"]);
  seedSide(inter, "intermediates", ["diaPortLoos", "diaPortLbs", "diaStbdLoos", "diaStbdLbs"]);
  $("#setForestay").value = fs.in ?? "";
  // pre-bend: from the grid's intermediates row, falling back to the byBand reference
  let pbv = inter.in;
  if (pbv == null || pbv === "") {
    const pb = cfg.prebend?.byBand || {};
    const band = cfg.windRanges.find((r) => r.id === rid)?.band;
    if (band === "light") pbv = Array.isArray(pb.light) ? pb.light.join("–") : pb.light;
    else if (band === "heavy") pbv = Array.isArray(pb.heavy) ? pb.heavy.join("–") : pb.heavy;
    else pbv = pb.allPurpose;
  }
  $("#setPrebend").value = pbv ?? "";
  $("#logRange").value = rid;
  toast("Loaded " + setup.label + " @ " + rid);
}

function collectLogForm() {
  return {
    id: editingLogId || uid(),
    date: $("#logDate").value,
    venue: $("#logVenue").value.trim(),
    wind: $("#logWind").value.trim(),
    rangeId: $("#logRange").value,
    windDir: $("#logWindDir").value.trim(),
    settings: {
      forestay: $("#setForestay").value.trim(),
      prebend: $("#setPrebend").value.trim()
    },
    perSide: (() => {
      // loos inputs are in the active gauge -> store canonical Model A
      const side = (wireRow, loosId, lbsId) => ({
        loos: loosToStore(wireRow, $("#" + loosId).value.trim()) ?? "",
        lbs: $("#" + lbsId).value.trim()
      });
      return {
        uppers: { port: side("uppers", "upPortLoos", "upPortLbs"), stbd: side("uppers", "upStbdLoos", "upStbdLbs") },
        lowers: { port: side("lowers", "loPortLoos", "loPortLbs"), stbd: side("lowers", "loStbdLoos", "loStbdLbs") },
        intermediates: { port: side("intermediates", "diaPortLoos", "diaPortLbs"), stbd: side("intermediates", "diaStbdLoos", "diaStbdLbs") }
      };
    })(),
    performance: $("#logPerf").value.trim(),
    adjustments: $("#logAdj").value.trim(),
    notes: $("#logNotes").value.trim()
  };
}

function submitLog(e) {
  e.preventDefault();
  const p = activeProfile();
  const entry = collectLogForm();
  if (!entry.date) { alert("Date is required."); return; }
  if (editingLogId) {
    const i = p.log.findIndex((l) => l.id === editingLogId);
    if (i >= 0) p.log[i] = entry;
    toast("Entry updated");
  } else {
    p.log.push(entry);
    toast("Entry saved");
  }
  save();
  resetLogForm();
  renderLogList();
  renderAnalysis();
}

function resetLogForm() {
  $("#logForm").reset();
  editingLogId = null;
  $("#logSubmitBtn").textContent = "Save entry";
  $("#logCancelBtn").hidden = true;
  $("#logDate").value = new Date().toISOString().slice(0, 10);
}

function editLog(id) {
  const p = activeProfile();
  const l = p.log.find((x) => x.id === id);
  if (!l) return;
  editingLogId = id;
  $("#logDate").value = l.date || "";
  $("#logVenue").value = l.venue || "";
  $("#logWind").value = l.wind || "";
  $("#logRange").value = l.rangeId || "";
  $("#logWindDir").value = l.windDir || "";
  const s = l.settings || {};
  $("#setForestay").value = s.forestay || "";
  $("#setPrebend").value = s.prebend || "";
  const ps = l.perSide || {};
  const setSide = (wire, ids) => {
    const w = ps[wire] || {};
    $("#" + ids[0]).value = loosToDisplay(wire, w.port?.loos);   // canonical -> active gauge
    $("#" + ids[1]).value = w.port?.lbs || "";
    $("#" + ids[2]).value = loosToDisplay(wire, w.stbd?.loos);
    $("#" + ids[3]).value = w.stbd?.lbs || "";
  };
  setSide("uppers", ["upPortLoos", "upPortLbs", "upStbdLoos", "upStbdLbs"]);
  setSide("lowers", ["loPortLoos", "loPortLbs", "loStbdLoos", "loStbdLbs"]);
  setSide("intermediates", ["diaPortLoos", "diaPortLbs", "diaStbdLoos", "diaStbdLbs"]);
  $("#logPerf").value = l.performance || "";
  $("#logAdj").value = l.adjustments || "";
  $("#logNotes").value = l.notes || "";
  $("#logSubmitBtn").textContent = "Update entry";
  $("#logCancelBtn").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function deleteLog(id) {
  const p = activeProfile();
  if (!confirm("Delete this log entry?")) return;
  p.log = p.log.filter((x) => x.id !== id);
  save();
  renderLogList();
  renderAnalysis();
}

function settingsSummary(s) {
  if (!s) return "—";
  const parts = [];
  const wireStr = (w, lbl) => {
    if (!w) return null;
    const bits = [];
    if (w.loos) bits.push(`${w.loos} loos`);
    if (w.lbs) bits.push(`${w.lbs} lbs`);
    if (w.turns) bits.push(`${w.turns}t`);
    return bits.length ? `${lbl}: ${bits.join(" / ")}` : null;
  };
  parts.push(wireStr(s.intermediates, "Uppers"));
  parts.push(wireStr(s.uppers, "Intermediates"));
  parts.push(wireStr(s.lowers, "Lowers"));
  if (s.forestay) parts.push(`Forestay: ${s.forestay}"`);
  if (s.prebend) parts.push(`Pre-bend: ${s.prebend}"`);
  return parts.filter(Boolean).join(" · ") || "—";
}

function perSideSummary(ps) {
  if (!ps) return "";
  const out = [];
  const sideStr = (wire, side) => {
    if (side == null) return null;
    if (typeof side === "string") return side || null;            // legacy entries (single value)
    const loos = side.loos === "" || side.loos == null ? null : loosToDisplay(wire, side.loos);
    const bits = [loos, side.lbs].filter((x) => x !== "" && x != null);
    return bits.length ? bits.join("/") : null;
  };
  const add = (key, label) => {
    const w = ps[key];
    if (!w) return;
    const p = sideStr(key, w.port), s = sideStr(key, w.stbd);
    if (!p && !s) return;
    out.push(`${label} P ${p || "—"} · S ${s || "—"}`);
  };
  add("intermediates", "Uppers");
  add("uppers", "Intermediates");
  add("lowers", "Lowers");
  return out.length ? out.join("  |  ") + `  (${gaugeUnit()}/lbs)` : "";
}

function renderLogList() {
  const p = activeProfile();
  const filter = ($("#logSearch").value || "").toLowerCase();
  const host = $("#logList");
  let entries = clone(p.log).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (filter) {
    entries = entries.filter((l) => JSON.stringify(l).toLowerCase().includes(filter));
  }
  if (!entries.length) {
    host.innerHTML = `<p class="empty">${p.log.length ? "No entries match." : "No log entries yet. Add your first above."}</p>`;
    return;
  }
  const cfg = p.config;
  host.innerHTML = entries.map((l) => {
    const r = cfg.windRanges.find((x) => x.id === l.rangeId);
    const tape = r ? bandPill(r.band) : "";
    const ps = perSideSummary(l.perSide);
    return `<div class="log-entry">
      <div class="le-head">
        <span class="le-date">${esc(l.date)}</span>
        ${l.venue ? `<span>${esc(l.venue)}</span>` : ""}
        ${l.wind ? `<span class="pill">${esc(l.wind)} kn</span>` : ""}
        ${tape}
        ${l.windDir ? `<span class="muted">${esc(l.windDir)}</span>` : ""}
        <span class="le-actions">
          <button class="sm" data-editlog="${l.id}">Edit</button>
          <button class="sm danger" data-dellog="${l.id}">Delete</button>
        </span>
      </div>
      <div class="le-body">
        <div class="le-section"><h4>Settings sailed</h4><div class="val">${esc(settingsSummary(l.settings))}${ps ? `<br><span class="cell-sub">${esc(ps)}</span>` : ""}</div></div>
        ${l.performance ? `<div class="le-section"><h4>Performance</h4><div class="val">${esc(l.performance)}</div></div>` : ""}
        ${l.adjustments ? `<div class="le-section"><h4>Adjustments</h4><div class="val">${esc(l.adjustments)}</div></div>` : ""}
        ${l.notes ? `<div class="le-section"><h4>Notes</h4><div class="val">${esc(l.notes)}</div></div>` : ""}
      </div>
    </div>`;
  }).join("");
}

/* ============================================================
   ANALYSIS
   ============================================================ */
function renderAnalysis() {
  const p = activeProfile();
  const cfg = p.config;
  const host = $("#analysisHost");
  if (!p.log.length) { host.innerHTML = '<p class="empty">No log entries to analyze yet.</p>'; return; }

  const byRange = {};
  for (const l of p.log) {
    const key = l.rangeId || "unspecified";
    (byRange[key] = byRange[key] || []).push(l);
  }

  const blocks = cfg.windRanges.concat([{ id: "unspecified", knots: ["?", "?"], band: "—", tape: "blue" }])
    .filter((r) => byRange[r.id])
    .map((r) => {
      const entries = byRange[r.id].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      // reference (C4 setup if present, else first) for this range
      const refSetup = cfg.setups.find((s) => s.id === "c4") || cfg.setups[0];
      let refRow = "";
      if (refSetup && r.id !== "unspecified") {
        const up = resolveCell(refSetup, r.id, "uppers");
        const lo = resolveCell(refSetup, r.id, "lowers");
        const di = resolveCell(refSetup, r.id, "intermediates");
        const fs = resolveCell(refSetup, r.id, "forestay");
        refRow = `<tr style="opacity:.75"><td><strong>REF ${esc(refSetup.label)}</strong></td>
          <td>${fmtVal("intermediates", di)}</td><td>${fmtVal("uppers", up)}</td><td>${fmtVal("lowers", lo)}</td><td>${fmtVal("forestay", fs)}</td><td colspan="2" class="muted">reference grid</td></tr>`;
      }
      const sideStr = (wire, sd) => {
        if (sd == null) return null;
        if (typeof sd === "string") return sd || null;        // legacy single value
        const loos = sd.loos === "" || sd.loos == null ? null : loosToDisplay(wire, sd.loos);
        const b = [loos, sd.lbs].filter((x) => x !== "" && x != null);
        return b.length ? b.join("/") : null;
      };
      const rows = entries.map((l) => {
        const s = l.settings || {};
        const ps = l.perSide || {};
        const psCell = (wire, legacy) => {
          const w = ps[wire];
          if (!w) {
            if (legacy && (legacy.loos || legacy.lbs)) {
              return [legacy.loos && `${legacy.loos} loos`, legacy.lbs && `${legacy.lbs} lbs`].filter(Boolean).join("<br>");
            }
            return "—";
          }
          const pp = sideStr(wire, w.port), ss = sideStr(wire, w.stbd);
          if (!pp && !ss) return "—";
          return `P ${pp || "—"}<br>S ${ss || "—"}`;
        };
        return `<tr>
          <td>${esc(l.date)}${l.wind ? `<br><span class="cell-sub">${esc(l.wind)} kn</span>` : ""}</td>
          <td>${psCell("intermediates")}</td>
          <td>${psCell("uppers", s.uppers)}</td>
          <td>${psCell("lowers", s.lowers)}</td>
          <td>${s.forestay ? esc(s.forestay) + '"' : "—"}${s.prebend ? `<br><span class="cell-sub">pb ${esc(s.prebend)}"</span>` : ""}</td>
          <td>${esc((l.performance || "").slice(0, 80))}${(l.performance || "").length > 80 ? "…" : ""}</td>
          <td>${esc((l.adjustments || "").slice(0, 80))}${(l.adjustments || "").length > 80 ? "…" : ""}</td>
        </tr>`;
      }).join("");
      const label = r.id === "unspecified" ? "Unspecified range" : `${r.knots[0]}–${r.knots[1]} kn`;
      const sub = `<br><span class="cell-sub">P/S ${gaugeUnit()}/lbs</span>`;
      return `<div style="margin-bottom:18px;">
        <h3 style="margin:0 0 6px;">${label} ${bandPill(r.band)} <span class="analysis-target">${entries.length} entr${entries.length === 1 ? "y" : "ies"}</span></h3>
        <div class="grid-wrap"><table class="grid">
          <thead><tr><th>Date</th><th>Uppers${sub}</th><th>Intermediates${sub}</th><th>Lowers${sub}</th><th>Forestay / pb</th><th>Performance</th><th>Adjustments</th></tr></thead>
          <tbody>${refRow}${rows}</tbody>
        </table></div>
      </div>`;
    }).join("");

  host.innerHTML = blocks || '<p class="empty">No entries with a wind range set.</p>';
}

/* ============================================================
   PRINT — log & analysis use the on-screen view; the grid prints
   as a styled "tuning card" (see buildTuningCard).
   ============================================================ */
function printView(view) {
  switchView(view);
  const boat = activeProfile()?.name || "";
  const titles = { log: "Tuning Logbook", analysis: "Tuning Over Time" };
  const today = new Date().toISOString().slice(0, 10);
  $("#printHeader").innerHTML =
    `<div class="print-title">${esc(boat)} · ${esc(titles[view] || "")}</div>` +
    `<div class="print-meta">Gauge: ${esc(activeGauge())} · Printed ${esc(today)}</div>`;
  document.body.dataset.print = view;
  setTimeout(() => window.print(), 60);
}

function printGridCard() {
  $("#printCard").innerHTML = buildTuningCard();
  document.body.dataset.print = "card";
  setTimeout(() => window.print(), 60);
}

// Render the active boat's grid as a print-ready tuning card.
function buildTuningCard() {
  const prof = activeProfile();
  const cfg = prof.config;
  const setups = cfg.setups || [];
  const ranges = cfg.windRanges || [];
  const today = new Date().toISOString().slice(0, 10);
  const bandClass = { light: "r-light", medium: "r-med", heavy: "r-heavy" };

  // rows shown per range / in base. key "intermediates" supplies both the
  // masthead Uppers tension and the Pre-bend (its .in field).
  const ALL_ROWS = [
    { key: "intermediates", label: "Uppers", type: "tension" },
    { key: "uppers", label: "Intermediates", type: "tension" },
    { key: "lowers", label: "Lowers", type: "tension" },
    { key: "forestay", label: "Forestay", type: "inches" },
    { key: "intermediates", label: "Pre-bend", type: "inches" }
  ];
  // drop rows with no data anywhere (e.g. an unmeasured wire) to save space
  const cellHasValue = (row, c) => {
    if (!c) return false;
    if (row.type === "inches") return c.in != null && c.in !== "";
    return (c.lbs != null && c.lbs !== "") || (c.loos != null && c.loos !== "") || (c.note != null && c.note !== "");
  };
  const ROWS = ALL_ROWS.filter((row) =>
    setups.some((s) =>
      cellHasValue(row, (s.base || {})[row.key]) ||
      ranges.some((r) => cellHasValue(row, (s.byWind?.[r.id] || {})[row.key]))
    )
  );

  const dash = '<span class="muted">—</span>';
  const tension = (wire, cell, isWind) => {
    if (!cell || cell.empty) return dash;
    if (isWind && cell.sameAsBase) return '<span class="g">= base</span>';
    const out = [];
    if (isWind && cell.turns != null && cell.turns !== "")
      out.push(`<span class="d">${cell.turns > 0 ? "+" : ""}${esc(String(cell.turns))}</span>`);
    const lbs = cell.lbs != null && cell.lbs !== "" ? cell.lbs : null;
    const loos = cell.loos != null && cell.loos !== "" ? loosToDisplay(wire, cell.loos) : null;
    if (lbs != null) {
      out.push(esc(String(lbs)));
      if (loos != null && loos !== "") out.push(`<span class="g">(${esc(String(loos))})</span>`);
    } else if (loos != null && loos !== "") {
      out.push(`<span class="g">${esc(String(loos))}</span>`);
    } else if (cell.note) {
      return `<span class="note">${esc(cell.note)}</span>`;
    }
    if (!out.length) return dash;
    let s = out.join(" ");
    // note goes to the LEFT so the numbers stay right-aligned with the column
    if (cell.note) s = `<span class="g">${esc(cell.note)}</span> ` + s;
    return s;
  };
  const inches = (cell, isWind) => {
    if (!cell || cell.empty) return dash;
    if (isWind && cell.sameAsBase) return '<span class="g">= base</span>';
    return cell.in != null && cell.in !== "" ? `${esc(String(cell.in))}″` : dash;
  };
  const renderCell = (row, cell, isWind) =>
    row.type === "inches" ? inches(cell, isWind) : tension(row.key, cell, isWind);

  // base table
  const baseHead = `<tr><th>Setting</th>${setups.map((s) => `<th class="boatcol">${esc(s.label)}</th>`).join("")}</tr>`;
  const baseRows = ROWS.map((row) =>
    `<tr><td class="rowlabel">${esc(row.label)}</td>${
      setups.map((s) => `<td class="num">${renderCell(row, (s.base || {})[row.key], false)}</td>`).join("")
    }</tr>`
  ).join("");

  // matrix by wind range
  const matrixHead = `<tr><th colspan="2">Range · Tune</th>${setups.map((s) => `<th class="boatcol">${esc(s.label)}</th>`).join("")}</tr>`;
  const matrixBody = ranges.map((r) => {
    const rc = bandClass[r.band] || "r-med";
    return ROWS.map((row, i) => {
      const rangeCell = i === 0
        ? `<td class="range ${rc}" rowspan="${ROWS.length}">${r.knots[0]}–${r.knots[1]}<small>${esc(r.band)}</small></td>`
        : "";
      const cells = setups.map((s) => `<td class="num">${renderCell(row, (s.byWind?.[r.id] || {})[row.key], true)}</td>`).join("");
      return `<tr class="${i === 0 ? "grp" : ""}">${rangeCell}<td class="rowlabel">${esc(row.label)}</td>${cells}</tr>`;
    }).join("");
  }).join("");

  // notes: per-tune notes + global notes
  const noteItems = [];
  setups.forEach((s) => (s.notes || []).forEach((n) => noteItems.push(`<li><b>${esc(s.label)}:</b> ${esc(n)}</li>`)));
  (cfg.globalNotes || []).forEach((n) => noteItems.push(`<li>${esc(n)}</li>`));
  const notesBlock = noteItems.length ? `<div class="notes"><h3>Notes</h3><ul>${noteItems.join("")}</ul></div>` : "";

  const hullNote = (cfg.hull?.note || "").replace(/\s*Tool should support per-side values\.?/i, "").trim();
  const hullBlock = hullNote ? `<div class="hullnote">${esc(hullNote)}</div>` : "";
  const termBlock = cfg.terminology?.northSailsWarning
    ? `<div class="terminote"><b>Terminology:</b> ${esc(cfg.terminology.northSailsWarning)}</div>` : "";

  return `
  <div class="tcard">
    <header>
      <div>
        <p class="eyebrow">A Scow · ${esc(cfg.meta?.rig || "Swept Rig")}</p>
        <h1>${esc(prof.name)}</h1>
      </div>
      <div class="src">
        Tensions in <b>lbs</b><br>
        Gauge: <b>Loos ${esc(activeGauge())}</b><br>
        Printed ${esc(today)}
      </div>
    </header>
    <div class="wrap">
      <div class="section-label">Base Setting <span class="sub">(rest setup)</span></div>
      <table class="base"><thead>${baseHead}</thead><tbody>${baseRows}</tbody></table>
      <div class="section-label">By Wind Range <span class="sub">(adjust from base)</span></div>
      <table class="matrix"><thead>${matrixHead}</thead><tbody>${matrixBody}</tbody></table>
    </div>
    <div class="foot">
      <div class="legend">
        <span><b>(nn)</b> = Loos ${esc(activeGauge())} reading</span>
        <span><b class="d">+n</b> = turns from base → resulting lbs</span>
        <span><b>Forestay</b> = inches from deck plate (rake)</span>
        <span><span class="chip chip-b"></span>Light</span>
        <span><span class="chip chip-y"></span>Medium</span>
        <span><span class="chip chip-r"></span>Heavy</span>
      </div>
      ${notesBlock}
      ${hullBlock}
      ${termBlock}
    </div>
  </div>`;
}

/* ============================================================
   REFERENCE (collapsible on the grid page)
   ============================================================ */
function renderReference() {
  const cfg = activeProfile().config;
  $("#terminologyWarn").innerHTML = `<strong>Terminology:</strong> ${esc(cfg.terminology?.northSailsWarning || "")}`;
  const m = cfg.meta || {};
  const h = cfg.hull || {};
  $("#metaTable").innerHTML = [
    ["Class", m.class], ["Rig", m.rig], ["Gauge", m.gauge],
    ["Uppers", cfg.terminology?.intermediates], ["Intermediates", cfg.terminology?.uppers],
    ["Lowers", cfg.terminology?.lowers], ["Forestay", cfg.terminology?.forestay],
    ["Hull asymmetry", h.asymmetry_in != null ? `${h.asymmetry_in} in higher to ${h.higherSide}` : null],
    ["Pre-bend status", cfg.prebend && !cfg.prebend.confirmed ? "Unconfirmed — replace with your measured values" : null]
  ].filter(([, v]) => v).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  $("#globalNotes").innerHTML = (cfg.globalNotes || []).map((n) => `<li>${esc(n)}</li>`).join("");
}

/* ============================================================
   RIG DIAGRAM (experimental spike)
   Side + front schematic, shrouds colored by tension.
   ============================================================ */
// approximate 1x19 316 stainless breaking strengths (lbs), by wire size
const WIRE_BREAK = { "1/8": 2100, "5/32": 3300 };
// shrouds in North Sails naming, mapped to internal data keys
const DIAG_SHROUDS = [
  { id: "upper", label: "Upper", key: "intermediates" },
  { id: "inter", label: "Intermediate", key: "uppers" },
  { id: "lower", label: "Lower", key: "lowers" }
];
const diagState = { source: "tune", tuneId: null, rangeId: null, mode: "pct" };
const LBS_FULLSCALE = 1000;  // pounds mapped to the top of the color scale

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// low tension -> green, high -> red
function tensionColor(lbs, size) {
  if (lbs == null || isNaN(lbs)) return "#9aa6ad";
  let t;
  if (diagState.mode === "pct") {
    const brk = WIRE_BREAK[size] || 3000;
    t = clamp01((lbs / brk) / 0.30);     // 0–30% of breaking spans the scale (working range)
  } else {
    t = clamp01(lbs / LBS_FULLSCALE);
  }
  const hue = 120 * (1 - t);             // 120=green -> 0=red
  return `hsl(${Math.round(hue)}, 78%, 44%)`;
}

function diagTune() {
  const setups = activeProfile().config.setups;
  return setups.find((s) => s.id === diagState.tuneId) || setups[0];
}
function diagLogEntry() {
  return (activeProfile().log || []).find((l) => l.id === diagState.source);
}

// pounds from a grid cell (lbs, else convert canonical-Model-A loos)
function cellLbs(cell, size) {
  if (!cell) return null;
  if (cell.lbs != null && cell.lbs !== "") return +cell.lbs;
  if (cell.loos != null && cell.loos !== "") return gaugeToLbs("Model A", size, cell.loos);
  return null;
}
// pounds from a per-side {loos, lbs}
function sideLbs(sd, size) {
  if (!sd || typeof sd !== "object") return null;
  if (sd.lbs != null && sd.lbs !== "") return +sd.lbs;
  if (sd.loos != null && sd.loos !== "") return gaugeToLbs("Model A", size, sd.loos);
  return null;
}
const sideAvg = (o) => {
  const v = [o.port.lbs, o.stbd.lbs].filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// build {port:{lbs,size}, stbd:{lbs,size}, size} per shroud for the active source
function diagTensions() {
  const T = {};
  const isLog = diagState.source !== "tune";
  const entry = isLog ? diagLogEntry() : null;
  DIAG_SHROUDS.forEach((sh) => {
    const size = WIRE_SIZE[sh.key];
    if (isLog) {
      const w = entry?.perSide?.[sh.key] || {};
      T[sh.id] = { port: { lbs: sideLbs(w.port, size), size }, stbd: { lbs: sideLbs(w.stbd, size), size }, size };
    } else {
      const v = cellLbs(resolveCell(diagTune(), diagState.rangeId, sh.key), size);
      T[sh.id] = { port: { lbs: v, size }, stbd: { lbs: v, size }, size };
    }
  });
  return T;
}
function diagInches(key) {
  if (diagState.source !== "tune") {
    const s = diagLogEntry()?.settings || {};
    const v = parseFloat(key === "intermediates" ? s.prebend : s.forestay);
    return isNaN(v) ? null : v;
  }
  const cell = resolveCell(diagTune(), diagState.rangeId, key);
  const v = cell && cell.in != null && cell.in !== "" ? parseFloat(cell.in) : null;
  return isNaN(v) ? null : v;
}

function renderDiagram() {
  const cfg = activeProfile().config;
  const setups = cfg.setups || [];
  if (!setups.length) { $("#diagHost").innerHTML = '<p class="empty">No tunes.</p>'; return; }
  if (!setups.some((s) => s.id === diagState.tuneId)) diagState.tuneId = (setups.find((s) => s.id === activeSetupId) || setups[0]).id;
  const ranges = cfg.windRanges || [];
  if (!ranges.some((r) => r.id === diagState.rangeId)) diagState.rangeId = ranges[0]?.id;

  // source select: reference tune + log entries
  const logs = (activeProfile().log || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (diagState.source !== "tune" && !logs.some((l) => l.id === diagState.source)) diagState.source = "tune";
  const logOpts = logs.map((l) => {
    const r = ranges.find((x) => x.id === l.rangeId);
    const lab = [l.date, l.venue, r ? `${r.knots[0]}–${r.knots[1]}kn` : (l.wind ? l.wind + "kn" : "")].filter(Boolean).join(" · ");
    return `<option value="${l.id}" ${l.id === diagState.source ? "selected" : ""}>${esc(lab)}</option>`;
  }).join("");
  $("#diagSource").innerHTML =
    `<option value="tune" ${diagState.source === "tune" ? "selected" : ""}>Reference tune</option>` +
    (logOpts ? `<optgroup label="Log entries">${logOpts}</optgroup>` : "");

  const isLog = diagState.source !== "tune";
  $("#diagTune").innerHTML = setups.map((s) => `<option value="${s.id}" ${s.id === diagState.tuneId ? "selected" : ""}>${esc(s.label)}</option>`).join("");
  $("#diagRange").innerHTML = ranges.map((r) => `<option value="${r.id}" ${r.id === diagState.rangeId ? "selected" : ""}>${r.knots[0]}–${r.knots[1]} kn (${r.band})</option>`).join("");
  $("#diagMode").value = diagState.mode;
  $("#diagTune").disabled = isLog;
  $("#diagRange").disabled = isLog;

  const T = diagTensions();
  const prebend = diagInches("intermediates");
  const forestay = diagInches("forestay");

  $("#diagLegend").innerHTML = diagLegend(T, isLog);
  $("#diagHost").innerHTML =
    `<figure class="diag-fig">${diagramSide(T, prebend, forestay)}<figcaption>Side — bow right (rake &amp; pre-bend exaggerated)</figcaption></figure>` +
    `<figure class="diag-fig">${diagramFront(T)}<figcaption>Front — looking aft from the bow${isLog ? " (per-side)" : ""}</figcaption></figure>`;
}

function diagLegend(T, isLog) {
  const stops = "hsl(120,78%,44%) 0%, hsl(60,78%,44%) 50%, hsl(0,78%,44%) 100%";
  const ticks = diagState.mode === "pct"
    ? ["0%", "7.5%", "15%", "22.5%", "30%+"]
    : ["0", "250", "500", "750", "1000+"].map((x) => x + (x === "0" ? " lb" : ""));
  const fmt = (lbs, size) => {
    if (lbs == null) return "—";
    const pct = Math.round((lbs / (WIRE_BREAK[size] || 3000)) * 100);
    return `${Math.round(lbs)} lb · ${pct}%`;
  };
  const sw = (lbs, size) => `<span class="diag-sw" style="background:${tensionColor(lbs, size)}"></span>`;
  const head = isLog ? `<tr><td></td><td>Port</td><td>Stbd</td></tr>` : "";
  const rows = DIAG_SHROUDS.map((sh) => {
    const t = T[sh.id];
    if (isLog) {
      return `<tr><td>${sh.label} <span class="muted">(${t.size}")</span></td>
        <td>${sw(t.port.lbs, t.size)}${fmt(t.port.lbs, t.size)}</td>
        <td>${sw(t.stbd.lbs, t.size)}${fmt(t.stbd.lbs, t.size)}</td></tr>`;
    }
    return `<tr><td>${sw(t.port.lbs, t.size)}${sh.label}</td><td>${fmt(t.port.lbs, t.size)} <span class="muted">(${t.size}")</span></td></tr>`;
  }).join("");
  return `<div class="diag-legend">
    <div class="diag-scale">
      <div class="diag-bar" style="background:linear-gradient(90deg, ${stops})"></div>
      <div class="diag-ticks">${ticks.map((t) => `<span>${t}</span>`).join("")}</div>
      <div class="diag-scale-label">${diagState.mode === "pct" ? "tension as % of breaking strength" : "tension in pounds"}</div>
    </div>
    <table class="diag-tbl">${head}${rows}</table>
  </div>`;
}

// ----- geometry helpers -----
const lerp = (a, b, t) => a + (b - a) * t;
function line(x1, y1, x2, y2, color, w) {
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${w || 3}" stroke-linecap="round"/>`;
}
function poly(pts, color, w) {
  return `<polyline points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}" fill="none" stroke="${color}" stroke-width="${w || 3}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// quadratic-bezier point at t (0..1)
function qbez(p0, p1, p2, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
          u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
}

function diagramSide(T, prebend, forestay) {
  const W = 340, H = 440, deckY = 345, waterY = 360;
  const mastBaseX = 162, topY = 56;
  const rakePx = 34 + (forestay != null ? (forestay - 16) * 10 : 0);  // exaggerated rake
  const topX = mastBaseX - rakePx;                                    // masthead aft (left)
  // exaggerated forward bow; amplify around a ~3" baseline so the change between
  // settings (typically 4–5.5") is clearly visible, not just a few pixels.
  const bendPx = prebend != null ? Math.max(4, (prebend - 3) * 13) : 0;
  const base = [mastBaseX, deckY], top = [topX, topY];
  const ctrl = [(mastBaseX + topX) / 2 + bendPx, (deckY + topY) / 2];
  const lowP = qbez(base, ctrl, top, 0.40);     // lower spreader, on the mast
  const upP = qbez(base, ctrl, top, 0.64);      // upper spreader, on the mast
  const bowX = 322, bowDeckY = 334;
  const fwdCP = [mastBaseX + 18, deckY];        // lowers -> forward chainplate hole (toward bow)
  const aftCP = [mastBaseX - 22, deckY];        // intermediates -> aft chainplate hole
  const c = (id) => tensionColor(sideAvg(T[id]), T[id].size);
  // diamonds (uppers) are athwartship: shown edge-on as the bend line just aft of the mast
  const dOff = (p) => [p[0] - 7, p[1]];

  // Boom: horizontal at the light-air setting, then tilts up aft as the mast rakes.
  const rakeLight = 34 + (15.5 - 16) * 10;      // light-air reference rake (forestay 15.5")
  const mastH = deckY - topY;
  const boomTilt = Math.atan2(rakePx, mastH) - Math.atan2(rakeLight, mastH);  // >=0 as rake grows
  const goosX = mastBaseX, goosY = deckY - 6, boomLen = 80;
  const boomEnd = [goosX - boomLen * Math.cos(boomTilt), goosY - boomLen * Math.sin(boomTilt)];

  // Pre-bend measurement: straight chord tip->base, arrow at the widest gap.
  const chordMid = [(base[0] + top[0]) / 2, (base[1] + top[1]) / 2];
  const curveMid = qbez(base, ctrl, top, 0.5);
  const showPB = prebend != null && prebend > 0;
  const lblX = curveMid[0] + 56, lblY = curveMid[1] - 2;
  const pbMetric = !showPB ? "" : `
    <line x1="${base[0].toFixed(1)}" y1="${base[1]}" x2="${top[0].toFixed(1)}" y2="${top[1]}" stroke="#9aa6b0" stroke-width="1.5" stroke-dasharray="5 4"/>
    <line x1="${chordMid[0].toFixed(1)}" y1="${chordMid[1].toFixed(1)}" x2="${curveMid[0].toFixed(1)}" y2="${curveMid[1].toFixed(1)}" stroke="#c0392b" stroke-width="1.5"/>
    <line x1="${lblX.toFixed(1)}" y1="${lblY.toFixed(1)}" x2="${curveMid[0].toFixed(1)}" y2="${curveMid[1].toFixed(1)}" stroke="#c0392b" stroke-width="1.5" marker-end="url(#pbArrow)"/>
    <text x="${(lblX + 4).toFixed(1)}" y="${(lblY + 4).toFixed(1)}" class="diag-t" text-anchor="start" fill="#c0392b">pre-bend ${prebend}″</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" class="diag-svg" role="img" aria-label="Side view">
    <defs><marker id="pbArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0,1 L 9,5 L 0,9 z" fill="#c0392b"/></marker></defs>
    <line x1="12" y1="${waterY}" x2="${W - 12}" y2="${waterY}" stroke="#9fc3e0" stroke-width="2"/>
    <!-- foils -->
    <path d="M 222,353 L 230,353 L 226,406 L 222,406 Z" fill="#cdd6de" stroke="#33424f" stroke-width="1.5"/>
    <path d="M 64,353 L 72,353 L 69,388 L 66,388 Z" fill="#cdd6de" stroke="#33424f" stroke-width="1.5"/>
    <!-- hull: long, low scow; bow upswept (right), blunt transom (left), flat bottom -->
    <path d="M 46,344 C 110,343 235,342 ${bowX},${bowDeckY} C 331,337 331,346 320,352 C 300,357 230,357 170,357 C 112,357 64,357 54,356 C 47,355 44,350 46,344 Z" fill="#eef2f6" stroke="#33424f" stroke-width="2"/>
    <!-- boom (horizontal at light air, tilts with rake) -->
    ${line(goosX, goosY, boomEnd[0], boomEnd[1], "#5c6b76", 4)}
    <!-- diamonds (uppers / pre-bend wire), edge-on just aft of the mast -->
    <path d="M ${dOff(base)[0].toFixed(1)},${dOff(base)[1].toFixed(1)} Q ${dOff(ctrl)[0].toFixed(1)},${dOff(ctrl)[1].toFixed(1)} ${dOff(top)[0].toFixed(1)},${dOff(top)[1].toFixed(1)}" fill="none" stroke="${c("upper")}" stroke-width="3"/>
    <!-- mast: rake + pre-bend -->
    <path d="M ${base[0].toFixed(1)},${base[1].toFixed(1)} Q ${ctrl[0].toFixed(1)},${ctrl[1].toFixed(1)} ${top[0].toFixed(1)},${top[1].toFixed(1)}" fill="none" stroke="#2b3742" stroke-width="5"/>
    <!-- forestay -->
    ${line(topX, topY, bowX, bowDeckY, "#7d8a94", 2)}
    <!-- spreaders (athwartship, foreshortened) -->
    ${line(lowP[0], lowP[1], lowP[0] - 13, lowP[1] + 3, "#5c6b76", 3)}
    ${line(upP[0], upP[1], upP[0] - 11, upP[1] + 3, "#5c6b76", 3)}
    <!-- intermediates: mast @ upper spreader -> aft chainplate -->
    ${line(upP[0], upP[1], aftCP[0], aftCP[1], c("inter"), 4)}
    <!-- lowers: mast @ lower spreader -> forward chainplate -->
    ${line(lowP[0], lowP[1], fwdCP[0], fwdCP[1], c("lower"), 4)}
    <circle cx="${aftCP[0]}" cy="${aftCP[1]}" r="3" fill="#33424f"/>
    <circle cx="${fwdCP[0]}" cy="${fwdCP[1]}" r="3" fill="#33424f"/>
    ${pbMetric}
    <text x="${topX - 4}" y="${topY - 6}" class="diag-t" text-anchor="end">masthead</text>
    <text x="${bowX}" y="${bowDeckY - 8}" class="diag-t" text-anchor="middle">bow</text>
  </svg>`;
}

function diagramFront(T) {
  // To scale with the side view. A Scow: 38 ft LOA, 8 ft beam => beam ~= 21% of
  // length. Side-view hull spans ~268 px (= 38 ft) => ~7 px/ft. Beam 8 ft ~= 56 px.
  // Mast deck->masthead matches the side view (deckY 345 -> topY 56).
  const W = 340, H = 440, deckYb = 345, topY = 56;
  const cx = 170, halfBeam = 28;                        // 8 ft beam to scale
  const tilt = 4;                                       // exaggerated hull asymmetry (stbd high)
  const deckL = deckYb - tilt, deckR = deckYb + tilt;   // stbd=left higher, port=right lower
  const waterY = 360;                                  // matches the side view
  const mastH = deckYb - topY;
  const hLow = deckYb - 0.40 * mastH, hUp = deckYb - 0.64 * mastH;  // spreader heights (match side)
  const spLow = 17, spUp = 14;                          // spreader half-lengths (~2.5 / 2 ft)
  const tipLowY = hLow + 3, tipUpY = hUp + 3;           // tips swept slightly down
  const cpLX = cx - 26, cpRX = cx + 26;                 // chainplates near the rail, outboard of tips
  const c = (id, side) => tensionColor(T[id][side].lbs, T[id].size);

  // sign: +1 = port (viewer's right), -1 = stbd (viewer's left)
  const sideRig = (sign, sd, cpX, deck) => {
    const lowTipX = cx + sign * spLow, upTipX = cx + sign * spUp;
    return `
      ${line(cx, hLow, lowTipX, tipLowY, "#5c6b76", 2.5)}
      ${line(cx, hUp, upTipX, tipUpY, "#5c6b76", 2.5)}
      ${poly([[cx, deckYb], [lowTipX, tipLowY], [upTipX, tipUpY], [cx, topY]], c("upper", sd), 3)}
      ${poly([[cx, hUp], [lowTipX, tipLowY], [cpX, deck]], c("inter", sd), 3)}
      ${line(cx, hLow, cpX, deck, c("lower", sd), 3)}`;
  };

  const xl = cx - halfBeam, xr = cx + halfBeam, botY = deckYb + 13;  // flat, shallow scow hull
  return `<svg viewBox="0 0 ${W} ${H}" class="diag-svg" role="img" aria-label="Front view">
    <line x1="12" y1="${waterY}" x2="${W - 12}" y2="${waterY}" stroke="#9fc3e0" stroke-width="2"/>
    <path d="M ${xl},${deckL} L ${xr},${deckR} L ${xr - 2},${botY} Q ${cx},${botY + 3} ${xl + 2},${botY} Z" fill="#eef2f6" stroke="#33424f" stroke-width="2"/>
    ${sideRig(1, "port", cpRX, deckR)}
    ${sideRig(-1, "stbd", cpLX, deckL)}
    <!-- mast: plumb (vertical) regardless of deck tilt -->
    ${line(cx, deckYb, cx, topY, "#2b3742", 5)}
    <circle cx="${cpLX}" cy="${deckL}" r="2.5" fill="#33424f"/>
    <circle cx="${cpRX}" cy="${deckR}" r="2.5" fill="#33424f"/>
    <text x="${xl - 12}" y="${deckL - 10}" class="diag-t" text-anchor="end">Stbd</text>
    <text x="${xr + 12}" y="${deckR - 10}" class="diag-t" text-anchor="start">Port</text>
  </svg>`;
}

/* ============================================================
   CONVERTER (popup)
   ============================================================ */
function openConverter() {
  $("#convertModal").hidden = false;
  $("#convLbs").focus();
}
function closeConverter() { $("#convertModal").hidden = true; }

function runConvert(source) {
  const wire = $("#convWire").value;
  const lbsEl = $("#convLbs"), aEl = $("#convModelA"), ptEl = $("#convPT1");
  const show = (v) => (v == null ? "" : v);
  // derive the common lbs anchor from whichever field drove the change
  let lbs;
  if (source === "A") lbs = gaugeToLbs("Model A", wire, aEl.value);
  else if (source === "PT1") lbs = gaugeToLbs("PT-1", wire, ptEl.value);
  else lbs = num(lbsEl.value);                 // "lbs" or "wire"
  if (source !== "lbs") lbsEl.value = show(lbs);
  if (source !== "A") aEl.value = show(lbs == null ? null : lbsToGauge("Model A", wire, lbs));
  if (source !== "PT1") ptEl.value = show(lbs == null ? null : lbsToGauge("PT-1", wire, lbs));
  // flag Model A 5/32 readings outside the table's reliable range
  const aVal = num(aEl.value);
  const approx = wire === "5/32" && aVal != null && (aVal < 35 || aVal > 47);
  $("#convNote").textContent = approx
    ? "Model A 5/32 reading is outside the published table range — value is extrapolated."
    : "Type any field to convert the others. lbs is the common reference.";
}

/* ============================================================
   GAUGE TOGGLE (Model A / PT-1, app-wide)
   ============================================================ */
const PS_LOOS_FIELDS = [
  ["upPortLoos", "uppers"], ["upStbdLoos", "uppers"],
  ["loPortLoos", "lowers"], ["loStbdLoos", "lowers"],
  ["diaPortLoos", "intermediates"], ["diaStbdLoos", "intermediates"]
];

function applyGaugeLabels() {
  const g = activeGauge();
  const sel = $("#gaugeSelect");
  if (sel) sel.value = g;
  $$(".ps-unit").forEach((e) => (e.textContent = gaugeUnit()));
  const pg = $(".ps-gauge");
  if (pg) pg.textContent = g;
}

function setGauge(g) {
  const old = activeGauge();
  if (g === old || !GAUGES.includes(g)) return;
  // convert anything already typed into the log form to the new gauge
  for (const [id, wire] of PS_LOOS_FIELDS) {
    const el = $("#" + id);
    if (!el || el.value.trim() === "") continue;
    const c = convertReading(old, g, WIRE_SIZE[wire], el.value.trim());
    el.value = c == null ? "" : c;
  }
  state.gauge = g;
  save();
  applyGaugeLabels();
  renderAll();
  toast("Gauge: " + g);
}

/* ============================================================
   RENDER + EVENTS
   ============================================================ */
function renderAll() {
  renderProfileSelect();
  renderGrid();
  renderLogControls();
  renderLogList();
  renderAnalysis();
  renderReference();
  renderDiagram();
}

function switchView(name) {
  $$("nav.tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
}

function bindEvents() {
  // tabs
  $$("nav.tabs button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

  // profile bar
  $("#profileSelect").addEventListener("change", (e) => setActiveProfile(e.target.value));
  $("#btnNewProfile").addEventListener("click", newProfile);
  $("#btnRenameProfile").addEventListener("click", renameProfile);
  $("#btnDeleteProfile").addEventListener("click", deleteProfile);
  $("#btnExport").addEventListener("click", exportProfile);
  $("#btnImport").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (e) => { if (e.target.files[0]) { importProfile(e.target.files[0]); e.target.value = ""; } });

  // grid: setup tabs + cell edits (event delegation)
  $("#setupTabs").addEventListener("click", (e) => {
    if (e.target.closest("#btnRenameSetup")) { renameSetup(); return; }
    if (e.target.closest("#btnDupSetup")) { duplicateSetup(); return; }
    const b = e.target.closest("button[data-setup]");
    if (b) { activeSetupId = b.dataset.setup; renderGrid(); }
  });
  $("#gridHost").addEventListener("change", (e) => {
    if (e.target.matches("input[data-cell]")) commitCellEdit(e.target);
  });
  $("#btnAddSetup").addEventListener("click", addSetup);

  // print
  $("#btnPrintGrid").addEventListener("click", printGridCard);
  $("#btnPrintLog").addEventListener("click", () => printView("log"));
  $("#btnPrintAnalysis").addEventListener("click", () => printView("analysis"));
  window.addEventListener("afterprint", () => {
    delete document.body.dataset.print;
    $("#printCard").innerHTML = "";
  });

  $("#setupNotes").addEventListener("click", (e) => {
    if (e.target.id === "btnAddNote") {
      const setup = activeProfile().config.setups.find((s) => s.id === activeSetupId);
      const n = prompt("Add a note for " + setup.label + ":", "");
      if (n) { setup.notes = setup.notes || []; setup.notes.push(n); save(); renderSetupNotes(setup); }
    } else if (e.target.dataset.delnote != null) {
      const setup = activeProfile().config.setups.find((s) => s.id === activeSetupId);
      setup.notes.splice(+e.target.dataset.delnote, 1); save(); renderSetupNotes(setup);
    } else if (e.target.id === "btnDelSetup") {
      const cfg = activeProfile().config;
      if (cfg.setups.length <= 1) { alert("Keep at least one tune."); return; }
      const setup = cfg.setups.find((s) => s.id === activeSetupId);
      if (confirm(`Delete tune “${setup.label}”?`)) {
        cfg.setups = cfg.setups.filter((s) => s.id !== activeSetupId);
        activeSetupId = cfg.setups[0].id;
        save(); renderGrid(); renderLogControls();
      }
    }
  });

  // log
  $("#logForm").addEventListener("submit", submitLog);
  $("#btnPrefill").addEventListener("click", prefillFromSetup);
  $("#logCancelBtn").addEventListener("click", resetLogForm);
  $("#logSearch").addEventListener("input", renderLogList);
  $("#logList").addEventListener("click", (e) => {
    if (e.target.dataset.editlog) { editLog(e.target.dataset.editlog); switchView("log"); }
    else if (e.target.dataset.dellog) deleteLog(e.target.dataset.dellog);
  });

  // rig diagram controls
  $("#diagSource").addEventListener("change", (e) => { diagState.source = e.target.value; renderDiagram(); });
  $("#diagTune").addEventListener("change", (e) => { diagState.tuneId = e.target.value; renderDiagram(); });
  $("#diagRange").addEventListener("change", (e) => { diagState.rangeId = e.target.value; renderDiagram(); });
  $("#diagMode").addEventListener("change", (e) => { diagState.mode = e.target.value; renderDiagram(); });

  // gauge toggle (app-wide Model A / PT-1)
  $("#gaugeSelect").addEventListener("change", (e) => setGauge(e.target.value));

  // converter popup
  $("#btnConvert").addEventListener("click", openConverter);
  $("#convertClose").addEventListener("click", closeConverter);
  $("#convertModal").addEventListener("click", (e) => {
    if (e.target === $("#convertModal")) closeConverter();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#convertModal").hidden) closeConverter();
  });
  $("#convWire").addEventListener("change", () => runConvert("lbs"));
  $("#convLbs").addEventListener("input", () => runConvert("lbs"));
  $("#convModelA").addEventListener("input", () => runConvert("A"));
  $("#convPT1").addEventListener("input", () => runConvert("PT1"));
}

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  applyGaugeLabels();
  renderAll();                 // instant render from localStorage
  $("#logDate").value = new Date().toISOString().slice(0, 10);
  showIdentity();
  pullFromServer().then((changed) => { if (changed) renderAll(); });

  // pick up edits made on another device when returning to this tab
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !editingLogId) {
      pullFromServer().then((changed) => { if (changed) renderAll(); });
    }
  });
});
