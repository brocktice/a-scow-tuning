/* A Scow Rig Tuning — log & config editor.
   Pure client-side, localStorage-backed. No build step. */
"use strict";

const STORE_KEY = "ascow-tuning/v1";
const WIRE_KEYS = ["uppers", "lowers", "intermediates", "forestay"];
const WIRE_LABELS = {
  uppers: "Uppers",
  lowers: "Lowers",
  intermediates: "Diamond",
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
    c.terminology = c.terminology || {};
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
function gaugeUnit() { return activeGauge() === "PT-1" ? "PT-1" : "loos"; }

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

function save() {
  const p = activeProfile();
  if (p) p.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    alert("Could not save to browser storage: " + e.message);
  }
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

/* lowers ≈ 0.5 * uppers validation; returns array of violation strings */
function validateSetup(setup, ranges) {
  const out = [];
  for (const r of ranges) {
    const up = resolveCell(setup, r.id, "uppers");
    const lo = resolveCell(setup, r.id, "lowers");
    if (up.lbs != null && lo.lbs != null) {
      const ideal = 0.5 * up.lbs;
      const ratio = lo.lbs / up.lbs;
      if (ratio < 0.38 || ratio > 0.62) {
        out.push(`${setup.label} @ ${r.id} kn: lowers ${lo.lbs} vs ½·uppers ${Math.round(ideal)} (ratio ${(ratio).toFixed(2)})`);
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
  if (!setups.length) { $("#gridHost").innerHTML = '<p class="empty">No setups. Add one.</p>'; $("#setupTabs").innerHTML = ""; $("#setupNotes").innerHTML = ""; return; }
  if (!setups.some((s) => s.id === activeSetupId)) activeSetupId = setups[0].id;

  // setup tabs
  $("#setupTabs").innerHTML = setups
    .map((s) => `<button data-setup="${s.id}" class="${s.id === activeSetupId ? "active" : ""}">${esc(s.label)}</button>`)
    .join("");

  const setup = setups.find((s) => s.id === activeSetupId);
  const ranges = cfg.windRanges;

  // warnings
  const viol = validateSetup(setup, ranges);
  $("#gridWarnings").innerHTML = viol.length
    ? `<div class="banner warn"><strong>Rule-of-thumb check (lowers ≈ ½ uppers):</strong><ul class="notes-list">${viol.map((v) => `<li>${esc(v)}</li>`).join("")}</ul><span class="muted">Surfaced for verification — not auto-corrected.</span></div>`
    : "";

  // header row
  const rangeHead = ranges.map((r) => {
    const lo = r.knots[0], hi = r.knots[1];
    return `<th>${lo}–${hi} kn <span class="pill tape-${r.tape}">${r.band}</span></th>`;
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
  // re-render warnings only (avoid losing focus on full re-render)
  const viol = validateSetup(setup, activeProfile().config.windRanges);
  $("#gridWarnings").innerHTML = viol.length
    ? `<div class="banner warn"><strong>Rule-of-thumb check (lowers ≈ ½ uppers):</strong><ul class="notes-list">${viol.map((v) => `<li>${esc(v)}</li>`).join("")}</ul><span class="muted">Surfaced for verification — not auto-corrected.</span></div>`
    : "";
}

function renderSetupNotes(setup) {
  const notes = setup.notes || [];
  $("#setupNotes").innerHTML = `
    <div class="flex-between" style="margin-top:16px;">
      <h2 style="font-size:14px;margin:0;">${esc(setup.label)} — notes</h2>
      <div>
        <button class="sm" id="btnAddNote">+ Note</button>
        <button class="sm danger" id="btnDelSetup">Delete this setup</button>
      </div>
    </div>
    ${notes.length ? `<ul class="notes-list">${notes.map((n, i) => `<li>${esc(n)} <button class="sm ghost" data-delnote="${i}" title="remove">✕</button></li>`).join("")}</ul>` : '<p class="muted">No notes.</p>'}`;
}

function addSetup() {
  const label = prompt("Name for the new setup column (e.g. a sailor or a season):", "");
  if (!label) return;
  const cfg = activeProfile().config;
  const setup = {
    id: uid(),
    label,
    base: { uppers: {}, lowers: {}, intermediates: {}, forestay: {} },
    byWind: {},
    notes: []
  };
  cfg.windRanges.forEach((r) => { setup.byWind[r.id] = { uppers: {}, lowers: {}, intermediates: {}, forestay: {} }; });
  cfg.setups.push(setup);
  activeSetupId = setup.id;
  save();
  renderGrid();
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
  parts.push(wireStr(s.uppers, "Uppers"));
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
  add("uppers", "Uppers");
  add("lowers", "Lowers");
  add("intermediates", "Diamonds");
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
    const tape = r ? `<span class="pill tape-${r.tape}">${r.band}</span>` : "";
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
          <td>${fmtVal("uppers", up)}</td><td>${fmtVal("lowers", lo)}</td><td>${fmtVal("intermediates", di)}</td><td>${fmtVal("forestay", fs)}</td><td colspan="2" class="muted">reference grid</td></tr>`;
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
          <td>${psCell("uppers", s.uppers)}</td>
          <td>${psCell("lowers", s.lowers)}</td>
          <td>${psCell("intermediates")}</td>
          <td>${s.forestay ? esc(s.forestay) + '"' : "—"}${s.prebend ? `<br><span class="cell-sub">pb ${esc(s.prebend)}"</span>` : ""}</td>
          <td>${esc((l.performance || "").slice(0, 80))}${(l.performance || "").length > 80 ? "…" : ""}</td>
          <td>${esc((l.adjustments || "").slice(0, 80))}${(l.adjustments || "").length > 80 ? "…" : ""}</td>
        </tr>`;
      }).join("");
      const label = r.id === "unspecified" ? "Unspecified range" : `${r.knots[0]}–${r.knots[1]} kn`;
      const sub = `<br><span class="cell-sub">P/S ${gaugeUnit()}/lbs</span>`;
      return `<div style="margin-bottom:18px;">
        <h3 style="margin:0 0 6px;">${label} <span class="pill tape-${r.tape}">${r.band}</span> <span class="analysis-target">${entries.length} entr${entries.length === 1 ? "y" : "ies"}</span></h3>
        <div class="grid-wrap"><table class="grid">
          <thead><tr><th>Date</th><th>Uppers${sub}</th><th>Lowers${sub}</th><th>Diamonds${sub}</th><th>Forestay / pb</th><th>Performance</th><th>Adjustments</th></tr></thead>
          <tbody>${refRow}${rows}</tbody>
        </table></div>
      </div>`;
    }).join("");

  host.innerHTML = blocks || '<p class="empty">No entries with a wind range set.</p>';
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
    ["Uppers", cfg.terminology?.uppers], ["Lowers", cfg.terminology?.lowers],
    ["Pre-bend / diamond", cfg.terminology?.intermediates], ["Forestay", cfg.terminology?.forestay],
    ["Hull asymmetry", h.asymmetry_in != null ? `${h.asymmetry_in} in higher to ${h.higherSide}` : null],
    ["Pre-bend status", cfg.prebend && !cfg.prebend.confirmed ? "Unconfirmed — replace with your measured values" : null]
  ].filter(([, v]) => v).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  $("#globalNotes").innerHTML = (cfg.globalNotes || []).map((n) => `<li>${esc(n)}</li>`).join("");
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
    const b = e.target.closest("button[data-setup]");
    if (b) { activeSetupId = b.dataset.setup; renderGrid(); }
  });
  $("#gridHost").addEventListener("change", (e) => {
    if (e.target.matches("input[data-cell]")) commitCellEdit(e.target);
  });
  $("#btnAddSetup").addEventListener("click", addSetup);
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
      if (cfg.setups.length <= 1) { alert("Keep at least one setup."); return; }
      const setup = cfg.setups.find((s) => s.id === activeSetupId);
      if (confirm(`Delete setup column “${setup.label}”?`)) {
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
