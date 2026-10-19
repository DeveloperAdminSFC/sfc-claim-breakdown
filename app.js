/* =============================================================================
   Claim Breakdown by Trade — standalone tool
   -----------------------------------------------------------------------------
   Flow:
     1. Upload a claim PDF.
     2. The PDF is sent to the Cloud Run backend's /api/estimates/{job}/parse
        endpoint, which extracts every line item.
     3. You review/correct the trade on each line.
     4. Build a one-page summary (O&P · Tax · RCV · Paid When Incurred · Recoverable
        Dep · Non-Recoverable Dep · ACV by trade) and Save as PDF.

   Nothing is persisted. Parsed line items live in the page for the session and
   are gone on refresh.

   Depreciation is TWO mutually-exclusive buckets — never a single "depreciation"
   number. Every depreciating line is EITHER recoverable OR non-recoverable:
     • recoverableDep + nonRecoverableDep = the line's total depreciation (one is 0).
     • When the split is undetermined, BOTH are 0 (a blank slate the user fills in) —
       we never dump the amount into recoverableDep and call it recoverable.
   Paid-when-incurred lines (struck through in the source; carrier marks debris
   removal etc. as paid at actuals) are carved OUT of ACV:
     • paidWhenIncurred (bool) per line; its carve-out amount is the line's own RCV.
     • Line-level ACV = RCV − recoverableDep − nonRecoverableDep (the struck line
       still shows its full RCV as ACV, matching the source document).
     • Trade / grand-total ACV additionally subtracts Σ paidWhenIncurred, so the
       total lands on the claim's stated ACV. The exclusion happens once, at the roll-up.
   O&P / Taxes are NOT tracked per trade — they exist only as estimate-wide totals,
   shown in the summary Total row.
   ========================================================================== */

// ------------------------------- Trades ---------------------------------- //
// Display order — mirrors TRADE_OPTIONS in the OI platform.
// Brand mark printed in the top-right corner of every page (summary and estimate).
const LOGO_HTML = '<img class="page-logo" src="sfc-logo.png" alt="Summit First Construction">';
const BRAND_ROW = `<div class="page-brand">${LOGO_HTML}</div>`;

const TRADE_ORDER = [
  "ROOF",
  "GUTTERS",
  "SIDING",
  "STUCCO",
  "WINDOWS",
  "SOLAR",
  "PAINT",
  "FENCE",
  "GARAGE",
  "MISC",
  // Adjustment lines: miscalculated or summary-only values (sales tax, O&P, depreciation taken on
  // them, anything needed to make the sheet match the claim). This tool's copy only.
  "PRICE ADJUSTMENT",
  // Contents / personal-property lines (bird bath, grill, patio furniture, …). This tool's copy
  // only — NOT present in the OI platform's canonical TRADE_OPTIONS.
  "PERSONAL PROPERTY",
  "Not Trade Related",
  "Not Categorized",
];

// Accent colors — mirror TRADE_BADGE / TRADE_CHART_COLORS in the OI platform.
const TRADE_COLORS = {
  ROOF: "#3b82f6",
  GUTTERS: "#10b981",
  SIDING: "#f59e0b",
  STUCCO: "#84cc16",
  WINDOWS: "#8b5cf6",
  SOLAR: "#06b6d4",
  PAINT: "#f43f5e",
  FENCE: "#f97316",
  GARAGE: "#6366f1",
  MISC: "#64748b",
  "PRICE ADJUSTMENT": "#0f766e",
  "PERSONAL PROPERTY": "#d946ef", // fuchsia — distinct from the 11 above
  "Not Trade Related": "#94a3b8",
  "Not Categorized": "#cbd5e1",
};

// --------------------------- Backend config ------------------------------ //
// Production backend (Cloud Run). Its /api/estimates/{job}/parse endpoint parses the
// PDF server-side and returns { items, summary, validation }.
// Dev override: ?backend=http://localhost:8000 points every call at a local backend.
// Guarded so the Node test harness (vm sandbox, no window) can still load this file.
const BACKEND_URL =
  (typeof location !== "undefined" && typeof URLSearchParams !== "undefined"
    ? new URLSearchParams(location.search).get("backend")
    : null) ||
  "https://sfc-operational-intelligence-git-101019263046.us-central1.run.app";

// ------------------------------- State ----------------------------------- //
// The parsed line items for the current claim. Trade is editable in the review
// table before the summary is built. jobInfo is optional display-only metadata
// (Job # + Client) linked via the job picker; it does not affect parsing.
//
// structures is a purely client-side organizational layer applied AFTER parsing:
// the physical structures on the claim (House, Shed, Detached Garage). Each is
// { id, name } — assignment is by stable id, so renaming never touches items.
// Every line item carries a structureId. Nothing persists (session state only).
let state = { items: [], summary: {}, jobInfo: null, structures: [], nextStructureNum: 1 };

// Monotonic id source for structures — stable across renames/deletes.
let structSeq = 0;
const newStructId = () => "s" + (++structSeq);

// One structure on parse, named "Structure 1", with every line assigned to it.
function initStructures() {
  const first = { id: newStructId(), name: "Structure 1" };
  state.structures = [first];
  state.nextStructureNum = 2; // next auto-name is "Structure 2"
  for (const it of state.items) it.structureId = first.id;
}

// Find a structure by id (falls back to the first structure, which always exists).
function structureById(id) {
  return state.structures.find((s) => s.id === id) || state.structures[0];
}

// ------------------------------ Helpers ---------------------------------- //
const fmtUSD = (n) =>
  (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

// Em-dash placeholder for an empty/zero money cell.
const dashHTML = '<span class="dash">—</span>';

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setStatus(msg, kind) {
  const el = document.getElementById("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

// ---------------------- Job picker (Job # lookup) ------------------------ //
// Optional, display-only: links the claim to a JobNimbus job for the printed
// "Job #" / "Client" rows. Typing a job number resolves it via
// GET /api/jobs/{job_number} → state.jobInfo; the inline "✓ <name>" is the only
// feedback. This does not affect PDF parsing.

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Look up a single job by number. Returns the job detail, null on 404, throws on
// other errors.
async function fetchJob(jobNumber) {
  const res = await fetch(`${BACKEND_URL}/api/jobs/${encodeURIComponent(jobNumber)}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Job lookup failed (${res.status}).`);
  return res.json(); // JobDetailResponse: { job_number, contact_name, address, ... }
}

// Write the confirmation text (green ✓ on success, muted otherwise) to every picker.
function setJobConfirm(text, kind) {
  document.querySelectorAll(".jobpicker .jp-confirm").forEach((el) => {
    el.textContent = text || "";
    el.className = "jp-confirm" + (kind ? " " + kind : "");
  });
}

// Commit a resolved job to shared state and reflect it in every picker instance.
function applyJob(job) {
  state.jobInfo = {
    job_number: job.job_number,
    contact_name: job.contact_name || job.job_name || null,
    address: job.address || null,
  };
  syncJobUI();
}

// Reflect the current jobInfo into all pickers (both empty-state and toolbar stay
// in sync). Success shows a green "✓ <name>".
function syncJobUI() {
  const j = state.jobInfo;
  if (j) {
    document.querySelectorAll(".jobpicker .jp-number").forEach((el) => (el.value = String(j.job_number)));
    setJobConfirm(j.contact_name ? `✓ ${j.contact_name}` : "✓ Linked", "ok");
  } else {
    setJobConfirm("", "");
  }
}

// Clear the link and show a muted message (e.g. "Job not found"); leaves the
// number the user typed in place.
function clearJob(message) {
  state.jobInfo = null;
  setJobConfirm(message || "", "muted");
}

// Monotonic counter so only the newest in-flight lookup applies.
let jobLookupSeq = 0;

async function lookupJob(n) {
  const seq = ++jobLookupSeq;
  let job;
  try {
    job = await fetchJob(n);
  } catch {
    if (seq === jobLookupSeq) clearJob("Lookup failed");
    return;
  }
  if (seq !== jobLookupSeq) return; // superseded by a newer entry
  if (job) applyJob(job);
  else clearJob("Job not found");
}

// Wire one Job # input (debounced while typing, plus immediate on blur).
function setupJobPicker(root) {
  const numEl = root.querySelector(".jp-number");
  if (!numEl) return;
  const runLookup = debounce((v) => lookupJob(v), 400);

  numEl.addEventListener("input", () => {
    const n = numEl.value.trim();
    jobLookupSeq++; // invalidate any in-flight lookup
    if (!n) return clearJob("");
    if (!/^\d+$/.test(n)) return clearJob("Numbers only");
    runLookup(n);
  });
  numEl.addEventListener("blur", () => {
    const n = numEl.value.trim();
    if (/^\d+$/.test(n)) lookupJob(n); // resolve immediately on blur
  });
}

// Natural sort for line numbers ("1", "1a", "21b") — from estimate-print/page.tsx
function compareLineNumbers(a, b) {
  const tokenize = (s) => {
    const out = [];
    const re = /(\d+)|([a-zA-Z]+)/g;
    let m;
    while ((m = re.exec(String(s))) !== null) {
      out.push(m[1] !== undefined ? parseInt(m[1], 10) : m[2].toLowerCase());
    }
    return out;
  };
  const ta = tokenize(a), tb = tokenize(b);
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i];
    if (typeof x === "number" && typeof y === "number") { if (x !== y) return x - y; }
    else if (typeof x === "string" && typeof y === "string") { if (x !== y) return x < y ? -1 : 1; }
    else return typeof x === "number" ? -1 : 1;
  }
  return ta.length - tb.length;
}

// ------------------------------ PDF parse -------------------------------- //
// POST the raw PDF as multipart to the Cloud Run parse endpoint. Job number 0 is a
// harmless placeholder: parse_estimate reads/writes no job data (it has no BigQuery
// dependency), it only parses the PDF and returns { items, summary, validation }.
async function requestParse(file) {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${BACKEND_URL}/api/estimates/0/parse?estimate_type=initial`, {
    method: "POST",
    body: form, // no Content-Type header — the browser sets the multipart boundary
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || `Parser service error (${res.status}).`);
  return data; // { items, summary, validation } — validation ignored
}

async function parsePdf(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    return showEmptyError("That isn't a PDF. Choose a .pdf claim/estimate.");
  }
  if (file.size > 50_000_000) return showEmptyError("PDF is over 50MB — too large to parse in one pass.");

  showParsing(); // centered spinner; top-left status stays clean
  document.getElementById("pdfBtn").disabled = true;
  try {
    const parsed = await requestParse(file);

    // When the backend couldn't attribute the split, start the Non-Rec. Dep. column at ZERO — a
    // clean slate — rather than seeding it with an unreliable guess. The banner shows the stated
    // non-recoverable total so the user can mark lines by hand.
    const splitUndetermined = !!parsed.nonRecoverableSplitUndetermined;
    const items = (parsed.items || []).map((it) => {
      const rcv = Number(it.rcv) || 0;
      const dep = Number(it.depreciation) || 0; // parser still emits total dep + a type
      // Split into the two buckets from the type the parser derived — but ONLY when the
      // split is trusted. When undetermined, both stay 0: a blank slate the user fills in
      // (do NOT dump the amount into recoverableDep — the tool doesn't know it's recoverable).
      let recoverableDep = 0;
      let nonRecoverableDep = 0;
      if (!splitUndetermined && dep > 0) {
        if (it.depreciationType === "non-recoverable") nonRecoverableDep = dep;
        else recoverableDep = dep; // parser reconciled penny-exact → "recoverable" is trustworthy
      }
      return {
        number: it.number != null ? String(it.number) : "",
        section: it.section || "", // top-level estimate section; drives the display prefix
        description: it.description || "",
        quantity: it.quantity || "",
        rcv,
        // Per-line O&P and Tax (Xactimate "Total O&P"/"Total Taxes" columns). Already INCLUDED
        // inside rcv (a decomposition), shown per line/trade; 0 when the carrier has no such column.
        op: Number(it.op) || 0,
        tax: Number(it.tax) || 0,
        recoverableDep,
        nonRecoverableDep,
        // Roof payment schedule (RPS) customer portion: what the insurer will never pay on this
        // line because the policy pays the roof by a schedule. NOT depreciation — its own
        // bucket, editable, and it comes out of ACV like the others.
        rps: Math.max(0, Number(it.rpsCustomerPortion) || 0),
        // Struck-through in the source = paid when incurred (carved out of ACV). The parser
        // sends the carve-out AMOUNT (the struck line's RCV); 0 for normal lines. Editable.
        paidWhenIncurred: Number(it.paidWhenIncurred) || 0,
        acv: rcv - (Number(it.paidWhenIncurred) || 0) - recoverableDep - nonRecoverableDep - Math.max(0, Number(it.rpsCustomerPortion) || 0),
        trade: "Not Categorized", // every line starts uncategorized
      };
    });
    if (!items.length) throw new Error("No line items found in this PDF.");
    assignDisplayNumbers(items); // stamp displayNumber (C1… for later sections)
    // Summary-only sales tax / O&P and the depreciation the carrier takes on it at the recap
    // level sit on no line item; carry them as one editable line so every total ties.
    const adj = summaryAdjustmentLine(parsed, items);
    if (adj) items.push(adj);

    // Mutate in place — do NOT reassign `state`, which would drop state.jobInfo
    // (the linked Job #) and blank the summary's Job #/Client rows.
    state.items = items;
    state.summary = parsed.summary || {};
    // Surface the undetermined split so the user sets the Non-Rec. Dep. column manually.
    state.splitUndetermined = splitUndetermined;
    initStructures(); // one "Structure 1", every line assigned to it

    renderReview();
    setStatus(
      `Parsed ${items.length} line item${items.length === 1 ? "" : "s"}. ` +
      `All start “Not Categorized” — select lines and assign a trade, then Build summary.`,
      "ok"
    );
  } catch (err) {
    // Return to the centered empty state with the error shown there (not top-left).
    showEmptyError(`${err.message}${/failed to fetch/i.test(err.message) ? " — check your network." : ""}`);
  } finally {
    document.getElementById("pdfBtn").disabled = false;
  }
}

// ---------------------- Review / categorize table ------------------------ //
function tradeSelectHTML(selected, idAttr) {
  const opts = TRADE_ORDER.map(
    (t) => `<option value="${esc(t)}"${t === selected ? " selected" : ""}>${esc(t)}</option>`
  ).join("");
  return `<select class="input input-select trade-select" ${idAttr}>${opts}</select>`;
}

// A compact numeric input for an editable dollar amount.
function moneyInput(cls, i, value) {
  return `<input type="number" step="0.01" min="0" inputmode="decimal" class="amt ${cls}" data-i="${i}" value="${Number(value) || 0}" />`;
}

// ---------------------------- Structures --------------------------------- //
// Options for a structure <select>: value = stable id, label = user name. The
// optional "— no change —" sentinel (value "") heads the bulk selects so an Apply
// can target trade only, structure only, or both.
function structureOptionsHTML(selectedId, { noChange = false } = {}) {
  const head = noChange ? `<option value="">— no change —</option>` : "";
  return head + state.structures
    .map((s) => `<option value="${esc(s.id)}"${s.id === selectedId ? " selected" : ""}>${esc(s.name)}</option>`)
    .join("");
}

// Per-row structure dropdown (mirrors tradeSelectHTML).
function structureSelectHTML(selectedId, idAttr) {
  return `<select class="input input-select structure-select" ${idAttr}>${structureOptionsHTML(selectedId)}</select>`;
}

// Re-emit every structure dropdown after the list changes (add/rename/delete),
// preserving each row's current selection, and repaint the manager.
function syncStructures() {
  const bulk = document.getElementById("bulkStructureSelect");
  if (bulk) {
    const keep = bulk.value;
    bulk.innerHTML = structureOptionsHTML(keep, { noChange: true });
    if (!state.structures.some((s) => s.id === keep)) bulk.value = ""; // deleted → sentinel
  }
  document.querySelectorAll(".structure-select[data-i]").forEach((sel) => {
    const i = Number(sel.dataset.i);
    sel.innerHTML = structureOptionsHTML(state.items[i] ? state.items[i].structureId : null);
  });
  renderStructureManager();
}

// The structure manager UI — chips with an inline-editable name + delete, plus Add.
function renderStructureManager() {
  const host = document.getElementById("structureManager");
  if (!host) return;
  if (!state.items.length) { host.hidden = true; host.innerHTML = ""; return; }
  const soleStructure = state.structures.length <= 1; // last one can't be deleted
  const chips = state.structures
    .map(
      (s) => `
      <span class="struct-chip">
        <input class="struct-name" data-id="${esc(s.id)}" value="${esc(s.name)}"
          aria-label="Structure name" spellcheck="false" />
        <button class="struct-del" data-id="${esc(s.id)}" title="Delete structure"
          aria-label="Delete structure"${soleStructure ? " disabled" : ""}>✕</button>
      </span>`
    )
    .join("");
  host.innerHTML = `
    <span class="struct-label">Structures</span>
    <div class="struct-chips">${chips}</div>
    <button id="addStructureBtn" class="btn btn-ghost struct-add" type="button">+ Add structure</button>`;
  host.hidden = false;

  host.querySelectorAll(".struct-name").forEach((inp) =>
    inp.addEventListener("change", (e) => renameStructure(e.target.dataset.id, e.target.value, e.target))
  );
  host.querySelectorAll(".struct-del").forEach((btn) =>
    btn.addEventListener("click", (e) => deleteStructure(e.currentTarget.dataset.id))
  );
  const add = document.getElementById("addStructureBtn");
  if (add) add.addEventListener("click", addStructure);
}

function addStructure() {
  const s = { id: newStructId(), name: "Structure " + state.nextStructureNum++ };
  state.structures.push(s);
  syncStructures();
  setStatus(`Added “${s.name}”.`, "ok");
}

// Commit a rename or revert it (inputEl restores the prior value on reject). Blocks
// empty names and case-insensitive duplicates — the summary and dropdowns key on names.
function renameStructure(id, raw, inputEl) {
  const s = state.structures.find((x) => x.id === id);
  if (!s) return;
  const name = String(raw).trim();
  if (!name) {
    if (inputEl) inputEl.value = s.name;
    return setStatus("Structure name can't be empty.", "error");
  }
  if (state.structures.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
    if (inputEl) inputEl.value = s.name;
    return setStatus(`A structure named “${name}” already exists.`, "error");
  }
  s.name = name;
  syncStructures();
  setStatus(`Renamed to “${name}”.`, "ok");
}

// Delete a structure (never the last one); its line items fall back to the first
// remaining structure, reported in the status line.
function deleteStructure(id) {
  if (state.structures.length <= 1) return;
  const removed = state.structures.find((s) => s.id === id);
  state.structures = state.structures.filter((s) => s.id !== id);
  const fallback = state.structures[0];
  const moved = state.items.filter((it) => it.structureId === id);
  moved.forEach((it) => (it.structureId = fallback.id));
  syncStructures();
  const n = moved.length;
  setStatus(
    `Deleted “${removed ? removed.name : "structure"}”.` +
      (n ? ` ${n} line item${n === 1 ? "" : "s"} moved to “${fallback.name}”.` : ""),
    "ok"
  );
}

// The claim-summary adjustment line. Many carriers (Allstate, USAA) add Material Sales Tax
// (and sometimes Overhead & Profit) only in the summary, then depreciate it — or apply the roof
// payment schedule to it — at the recap level. None of that is on a line item, so the line sums
// never reach the carrier's RCV / depreciation / ACV. This builds ONE editable line holding:
//   RCV                 = summary O&P + sales tax (only when the parser found them excluded
//                         from line RCV)
//   Recoverable / Non-Rec = stated total − Σ line depreciation   (the tax depreciation)
//   RPS customer portion  = stated customer portion − Σ line portions
// Each residual is used only when it is positive and no larger than the tax itself — a bigger
// gap is a parsing problem to look at, not tax. Returns null when there is nothing to carry.
function summaryAdjustmentLine(parsed, items) {
  const s = (parsed && parsed.summary) || {};
  if (!parsed || parsed.opTaxIncludedSuggested !== false) return null;
  const rcv = Math.round(((Number(s.totalOP) || 0) + (Number(s.totalTax) || 0)) * 100) / 100;
  if (!(rcv > 0)) return null;
  const sum = (f) => items.reduce((a, it) => a + (Number(it[f]) || 0), 0);
  const resid = (stated, f) => {
    if (stated == null) return 0;
    const v = Math.round((Number(stated) - sum(f)) * 100) / 100;
    return v > 0.005 && v <= rcv ? v : 0;
  };
  const undetermined = !!parsed.nonRecoverableSplitUndetermined;
  const recoverableDep = undetermined ? 0 : resid(s.totalRecoverableDepreciation, "recoverableDep");
  const nonRecoverableDep = undetermined ? 0 : resid(s.totalNonRecoverableDepreciation, "nonRecoverableDep");
  const rps = resid(s.totalCustomerPortionRPS, "rps");
  return newAdjustmentLine({
    description: (Number(s.totalOP) || 0) > 0 ? "Overhead & profit and sales tax (claim summary)" : "Material sales tax (claim summary)",
    number: "TAX", trade: "PRICE ADJUSTMENT",
    rcv, recoverableDep, nonRecoverableDep, rps,
  });
}
// A blank or prefilled adjustment line: every amount is editable, the description is editable,
// and ACV can be typed directly. Every adjustment line — the auto claim-summary tax line and a
// hand-added one — starts in the PRICE ADJUSTMENT trade; the dropdown can move it to any trade.
function newAdjustmentLine({ description = "Price adjustment", number = "ADJ", trade = "PRICE ADJUSTMENT", rcv = 0, recoverableDep = 0, nonRecoverableDep = 0, rps = 0 } = {}) {
  return {
    number, displayNumber: number, section: "", description, quantity: "",
    rcv, op: 0, tax: 0, recoverableDep, nonRecoverableDep, rps, paidWhenIncurred: 0,
    acv: rcv - recoverableDep - nonRecoverableDep - rps,
    // acvManual: an ACV the user typed on this line. While set, it IS the line's ACV — no
    // equation — so the line can be pushed to whatever the claim says. null = follow the formula.
    acvManual: null,
    trade, isAdjustment: true,
  };
}
// A line's ACV, the single source for every total, table and estimate:
//   normal line      RCV − Paid When Incurred − Recoverable − Non-Recoverable − RPS customer portion
//   adjustment line  the typed ACV when the user set one, else the same formula
function itemACV(it) {
  if (it.isAdjustment && it.acvManual != null) return Number(it.acvManual) || 0;
  return (
    (Number(it.rcv) || 0) -
    (Number(it.paidWhenIncurred) || 0) -
    (Number(it.recoverableDep) || 0) -
    (Number(it.nonRecoverableDep) || 0) -
    (Number(it.rps) || 0)
  );
}

// Recompute a row's ACV cell live. ACV is the one computed cell and always:
//   ACV = RCV − Paid When Incurred − Recoverable Dep − Non-Recoverable Dep − RPS customer portion.
// All five inputs feed it, so editing any of them (or moving a value between buckets)
// just follows this single formula — no special cases.
function refreshAcvCell(i) {
  const it = state.items[i];
  it.acv = itemACV(it);
  const cell = document.querySelector(`.acv-cell[data-i="${i}"]`);
  if (!cell) return;
  // Adjustment lines hold an ACV input: follow the formula there only until the user types one.
  const inp = cell.querySelector(".acv-in");
  if (inp) { if (it.acvManual == null) inp.value = String(Math.round(it.acv * 100) / 100); }
  else cell.textContent = fmtUSD(it.acv);
}

// Warn when the parser could not confidently attribute the recoverable vs non-recoverable
// depreciation split. The claim's stated totals (when present) tell the user what the
// Non-Rec. Dep. column should add up to once they set it by hand.
function updateSplitBanner() {
  const el = document.getElementById("splitBanner");
  if (!el) return;
  if (!state.splitUndetermined) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const s = state.summary || {};
  let guide = "";
  if (s.totalNonRecoverableDepreciation != null) {
    guide = ` The claim states non-recoverable depreciation = <strong>${fmtUSD(s.totalNonRecoverableDepreciation)}</strong>` +
      (s.totalRecoverableDepreciation != null ? ` and recoverable = ${fmtUSD(s.totalRecoverableDepreciation)}` : "") + ".";
  }
  el.innerHTML =
    `<strong>Non-recoverable split not auto-detected.</strong> ` +
    `Set the <em>Non-Rec. Dep.</em> column manually for the affected lines.${guide}`;
  el.hidden = false;
}

// ---- Build-summary reconciliation (fires on "Build summary") ----
// True when two dollar amounts are equal to the cent (penny-exact; no tolerance).
function centsEqual(a, b) {
  return Math.round((Number(a) || 0) * 100) === Math.round((Number(b) || 0) * 100);
}

// Compare the line-item sums against the claim's own summary figures on four rows. Each bucket is
// summed DIRECTLY from its own per-line field (recoverable and non-recoverable are stored
// separately, not derived by subtraction). The ACV row uses the carrier identity
// RCV − paidWhenIncurred − recoverableDep − nonRecoverableDep, summing each bucket's own
// per-line amount — so a claim with deferred debris removal still reconciles.
// Rows whose summary figure is missing are shown but not counted as a mismatch.
function reconcileSummary() {
  const s = state.summary || {};
  const items = state.items;
  const sumRCV = items.reduce((a, it) => a + (Number(it.rcv) || 0), 0);
  const sumRecov = items.reduce((a, it) => a + (Number(it.recoverableDep) || 0), 0);
  const sumNonRec = items.reduce((a, it) => a + (Number(it.nonRecoverableDep) || 0), 0);
  const sumPWI = items.reduce((a, it) => a + (Number(it.paidWhenIncurred) || 0), 0);
  const sumRps = items.reduce((a, it) => a + (Number(it.rps) || 0), 0);
  const acvLineItems = items.reduce((a, it) => a + itemACV(it), 0);

  const defs = [
    { label: "RCV", lineItems: sumRCV, claim: s.totalRCV },
    { label: "Recoverable Dep.", lineItems: sumRecov, claim: s.totalRecoverableDepreciation },
    { label: "Non-Recoverable Dep.", lineItems: sumNonRec, claim: s.totalNonRecoverableDepreciation },
    // Roof payment schedule: only compared when the claim states a customer portion.
    ...(s.totalCustomerPortionRPS != null || sumRps > 0
      ? [{ label: "RPS Customer Portion", lineItems: sumRps, claim: s.totalCustomerPortionRPS }]
      : []),
    { label: "ACV", lineItems: acvLineItems, claim: s.totalACV },
  ];
  const rows = defs.map((d) => {
    const comparable = d.claim != null;
    return {
      label: d.label,
      lineItems: d.lineItems,
      claim: d.claim,
      comparable,
      match: !comparable || centsEqual(d.lineItems, d.claim),
    };
  });
  return { ok: rows.every((r) => r.match), rows };
}

// "Fix Discrepancy": add ONE price adjustment line sized to exactly what the reconcile check
// found, so the sheet matches the claim's own summary. Each bucket gets (claim − line items) for
// the rows the claim states; when the claim's ACV still differs from RCV minus those buckets, the
// ACV is set directly (typed ACV, no equation). Returns the line, or null when nothing is off.
function fixDiscrepancy() {
  const { rows } = reconcileSummary();
  const gap = (label) => {
    const r = rows.find((x) => x.label === label);
    return r && r.comparable ? Math.round((Number(r.claim) - r.lineItems) * 100) / 100 : 0;
  };
  const rcv = gap("RCV");
  const recoverableDep = gap("Recoverable Dep.");
  const nonRecoverableDep = gap("Non-Recoverable Dep.");
  const rps = gap("RPS Customer Portion");
  const acvRow = rows.find((x) => x.label === "ACV");
  const acvGap = gap("ACV");
  if (![rcv, recoverableDep, nonRecoverableDep, rps, acvGap].some((v) => Math.abs(v) > 0.005)) return null;
  const n = state.items.filter((it) => it.isAdjustment && String(it.number).startsWith("ADJ")).length;
  const line = newAdjustmentLine({
    description: "Price adjustment (match claim summary)",
    number: n ? `ADJ${n + 1}` : "ADJ",
    rcv, recoverableDep, nonRecoverableDep, rps,
  });
  const formula = rcv - recoverableDep - nonRecoverableDep - rps;
  if (acvRow && acvRow.comparable && Math.abs(acvGap - formula) > 0.005) line.acvManual = acvGap;
  line.acv = itemACV(line);
  state.items.push(line);
  return line;
}

function showDiscrepancyModal(rows) {
  const body = document.getElementById("discBody");
  body.innerHTML = rows
    .map((r) => {
      const claimCell = r.comparable ? fmtUSD(r.claim) : "—";
      const status = !r.comparable
        ? '<span class="disc-na">not stated</span>'
        : r.match
        ? '<span class="disc-ok">✓</span>'
        : `<span class="disc-bad">✗ off by ${fmtUSD(Math.abs(r.lineItems - r.claim))}</span>`;
      return `<tr class="${r.comparable && !r.match ? "disc-row-bad" : ""}">
        <td class="disc-label">${esc(r.label)}</td>
        <td class="disc-vals"><span class="disc-k">Line Items</span> ${fmtUSD(r.lineItems)}</td>
        <td class="disc-vals"><span class="disc-k">Claim Summary</span> ${claimCell}</td>
        <td class="disc-status">${status}</td>
      </tr>`;
    })
    .join("");
  document.getElementById("discrepancyModal").hidden = false;
}

function closeDiscrepancyModal() {
  document.getElementById("discrepancyModal").hidden = true;
}

// Toggle the empty-state (big upload button) vs. loaded chrome (compact toolbar).
function setLoadedChrome(loaded) {
  document.getElementById("empty").hidden = loaded;
  document.getElementById("toolbarActions").hidden = !loaded;
}

// Centered parse progress (replaces the empty-state content while a parse runs). A parse is a
// single server call (~20–60s on most claims; large multi-page ones longer), so after ~45s we
// gently escalate the copy client-side — a long, silent spinner otherwise reads as broken.
let parsingStageTimer = null;
function showParsing() {
  clearEmptyError();
  setStatus(""); // keep the top-left clean during parse
  document.getElementById("empty").hidden = true;
  document.getElementById("parsing").hidden = false;
  const label = document.getElementById("parsingLabel");
  const sub = document.getElementById("parsingSub");
  label.textContent = "Parsing claim…";
  sub.textContent = "usually 20–60 seconds";
  clearTimeout(parsingStageTimer);
  parsingStageTimer = setTimeout(() => {
    sub.textContent = "large multi-page claims can take a bit longer…";
  }, 45000);
}
function hideParsing() {
  clearTimeout(parsingStageTimer);
  document.getElementById("parsing").hidden = true;
}

// Parse/validation errors render centered in the empty state, not the top-left.
function showEmptyError(msg) {
  hideParsing();
  document.getElementById("empty").hidden = false;
  const el = document.getElementById("emptyError");
  el.textContent = msg || "";
  el.hidden = !msg;
}
function clearEmptyError() {
  const el = document.getElementById("emptyError");
  el.textContent = "";
  el.hidden = true;
}

// "Upload another claim" — fully reset to the home/empty state. The linked Job #
// (state.jobInfo) is PRESERVED on purpose: re-uploading a corrected claim for the
// same job is the common case. Only a manual field-clear removes it.
function resetToEmpty() {
  state.items = [];
  state.summary = {};
  state.splitUndetermined = false;
  state.structures = [];
  // state.jobInfo intentionally left untouched.
  closeSummaryModal();
  closeDiscrepancyModal();
  document.getElementById("review").hidden = true;
  document.getElementById("doc").innerHTML = "";
  hideParsing();
  clearEmptyError();
  setStatus("");
  setLoadedChrome(false);   // show empty state, hide toolbar actions
  syncJobUI();              // repaint preserved Job # + "✓ <name>" in the empty picker
}

// Stamp every item with a `displayNumber`. Prefixes exist ONLY to disambiguate line numbers
// that are REUSED across sections (LITKE: Contents restarts at 1 after Structure 1..48 → C1…).
// Many carriers number CONTINUOUSLY across sections (Xactimate panel estimates: 1..32 over 7
// sections) — those get NO prefixes at all; every displayNumber is the raw printed number.
//
// Rules (predictable — you can work out any section's prefix by hand):
//   • Sections are handled in first-appearance order; items whose section is "" (unlabeled)
//     belong to the first section. The first section is never prefixed.
//   • A later section is prefixed ONLY if one of its raw numbers already appeared in an
//     EARLIER section. Unique-everywhere numbering → zero prefixes.
//   • Prefixes are LETTERS ONLY — a digit-bearing prefix (the old "G2") can compose ambiguous
//     or genuinely colliding displayNumbers ("G2"+"16" === "G"+"216"). Candidates, first
//     unused wins: first letter of the section name → first letters of its first two words
//     ("Garage Gutters" → "GG") → first letter + "B", "C", …
function assignDisplayNumbers(items) {
  // Pass 1: group items by section in first-appearance order.
  const order = [];
  const bySection = new Map(); // section name -> its items
  for (const it of items) {
    const s = it.section || "";
    if (!bySection.has(s)) {
      bySection.set(s, []);
      order.push(s);
    }
    bySection.get(s).push(it);
  }
  // Pass 2: prefix only colliding sections.
  const prefixBySection = new Map();
  const used = new Set(); // prefixes already assigned
  const seen = new Set(); // raw numbers (uppercased) from all earlier sections
  for (const s of order) {
    const nums = bySection.get(s).map((it) => String(it.number).toUpperCase());
    let prefix = "";
    if (nums.some((n) => seen.has(n))) {
      const words = String(s).split(/[^A-Za-z]+/).filter(Boolean);
      const first = ((words[0] || "S")[0] || "S").toUpperCase();
      const candidates = [first];
      if (words.length > 1) candidates.push(first + words[1][0].toUpperCase());
      for (let c = 66; c <= 90; c++) candidates.push(first + String.fromCharCode(c)); // B..Z
      prefix = candidates.find((p) => !used.has(p)) || first + "Z";
      used.add(prefix);
    }
    prefixBySection.set(s, prefix);
    for (const n of nums) seen.add(n);
  }
  for (const it of items) {
    it.sectionPrefix = prefixBySection.get(it.section || "");
    it.displayNumber = it.sectionPrefix + String(it.number);
  }
  return items;
}

// Parse a line-range string ("1-5, 7, C1-C3, 21b, 40-C10") against the items' displayNumbers.
// Returns { wanted, bad }:
//   • wanted — Set of matched displayNumbers.
//   • bad    — array of tokens (verbatim, as typed) that failed: a malformed range, a range
//              endpoint that names no line, or a single ref that names no line.
// Semantics per comma token (case-insensitive):
//   • Plain-numeric range — both endpoints all digits ("3-7", "1-999"): numeric expansion over
//     the UNPREFIXED section, clamped to lines that exist. Missing endpoints/interior are fine
//     ("1-999" is the catch-all for every unprefixed line); never flagged bad.
//   • Any other range ("40-C10", "C2-C5", "21-21b"): BOTH endpoints must name existing lines
//     (exact displayNumber match); the token expands to every line BETWEEN them in DOCUMENT
//     ORDER, crossing section boundaries — "40-C10" is 40..48 then C1..C10. Reversed endpoints
//     swap ("C5-40" ≡ "40-C5"). An endpoint that names no line makes the whole token bad.
//   • Single ref ("7", "C2", "21b"): added if present; named bad if not.
function parseLineRange(str, items) {
  const indexByKey = new Map(); // UPPERCASE displayNumber -> index in document order
  items.forEach((it, i) => indexByKey.set(String(it.displayNumber).toUpperCase(), i));
  const dn = (i) => String(items[i].displayNumber);
  const wanted = new Set();
  const bad = [];
  for (const raw of String(str).split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const U = token.toUpperCase();
    const numRng = U.match(/^(\d+)\s*-\s*(\d+)$/);
    if (numRng) {
      // Plain-numeric range: clamp-to-existing over the unprefixed section.
      let lo = parseInt(numRng[1], 10), hi = parseInt(numRng[2], 10);
      if (lo > hi) [lo, hi] = [hi, lo];
      for (let n = lo; n <= hi; n++) {
        const i = indexByKey.get(String(n));
        if (i !== undefined) wanted.add(dn(i));
      }
      continue;
    }
    const rng = U.match(/^(.+?)\s*-\s*(.+)$/);
    if (rng) {
      // Document-order range: both endpoints must exist.
      const a = indexByKey.get(rng[1]), b = indexByKey.get(rng[2]);
      if (a === undefined || b === undefined) { bad.push(token); continue; }
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) wanted.add(dn(i));
      continue;
    }
    const i = indexByKey.get(U);
    if (i !== undefined) wanted.add(dn(i));
    else bad.push(token); // a single ref naming no line — same feedback as a bad endpoint
  }
  return { wanted, bad };
}

// The Deductible box on the review screen. state.summary.deductible is the single value: the
// claim's stated deductible when the parser found one, otherwise whatever is typed here (many
// appraisals leave it off the claim report). Flagged amber while it is missing.
function syncDeductibleUI() {
  const el = document.getElementById("dedInput");
  if (!el) return;
  const d = state.summary ? state.summary.deductible : null;
  if (document.activeElement !== el) el.value = d != null ? String(d) : "";
  el.closest(".ded-field").classList.toggle("missing", d == null);
}

function renderReview() {
  syncDeductibleUI();
  const body = document.getElementById("reviewBody");
  body.innerHTML = state.items
    .map((it, i) => `
      <tr data-i="${i}"${it.isAdjustment ? ' class="adj-row"' : ""}>
        <td class="num">${esc(it.displayNumber)}${it.isAdjustment ? `<button type="button" class="adj-del" data-i="${i}" title="Remove this line">✕</button>` : ""}</td>
        <td class="left desc">${it.isAdjustment ? `<input type="text" class="input desc-in" data-i="${i}" value="${esc(it.description)}" placeholder="Description" />` : esc(it.description)}</td>
        <td class="left">${esc(it.quantity)}</td>
        <td class="edit-col">${moneyInput("op-in", i, it.op)}</td>
        <td class="edit-col">${moneyInput("tax-in", i, it.tax)}</td>
        <td class="edit-col">${it.isAdjustment ? `<input type="number" step="0.01" inputmode="decimal" class="amt rcv-in" data-i="${i}" value="${Number(it.rcv) || 0}" />` : moneyInput("rcv-in", i, it.rcv)}</td>
        <td class="edit-col">${moneyInput("pwi-in", i, it.paidWhenIncurred)}</td>
        <td class="edit-col">${moneyInput("rec-in", i, it.recoverableDep)}</td>
        <td class="edit-col">${moneyInput("nonrec-in", i, it.nonRecoverableDep)}</td>
        <td class="edit-col">${moneyInput("rps-in", i, it.rps)}</td>
        <td class="acv-cell" data-i="${i}">${it.isAdjustment ? `<input type="number" step="0.01" inputmode="decimal" class="amt acv-in" data-i="${i}" value="${Math.round(itemACV(it) * 100) / 100}" title="Type the ACV to set it directly; clear it to follow RCV minus depreciation" />` : fmtUSD(it.acv)}</td>
        <td class="left">${tradeSelectHTML(it.trade, `data-i="${i}"`)}</td>
        <td class="left">${structureSelectHTML(it.structureId, `data-i="${i}"`)}</td>
      </tr>`)
    .join("");

  // Per-row trade selects.
  body.querySelectorAll(".trade-select").forEach((sel) =>
    sel.addEventListener("change", (e) => {
      state.items[Number(e.target.dataset.i)].trade = e.target.value;
    })
  );

  // Per-row structure selects (value = structure id).
  body.querySelectorAll(".structure-select").forEach((sel) =>
    sel.addEventListener("change", (e) => {
      state.items[Number(e.target.dataset.i)].structureId = e.target.value;
    })
  );

  // Editable amounts. All four inputs (RCV, Paid When Incurred, Recoverable, Non-Recoverable)
  // are independent peers that drive ACV live, so a value can be moved between any of them by
  // hand and the math just follows: ACV = RCV − PWI − recoverable − non-recoverable.
  body.querySelectorAll(".rcv-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      state.items[i].rcv = Number(e.target.value) || 0;
      refreshAcvCell(i);
    })
  );
  body.querySelectorAll(".pwi-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      state.items[i].paidWhenIncurred = Math.max(0, Number(e.target.value) || 0);
      refreshAcvCell(i);
    })
  );
  body.querySelectorAll(".rec-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      state.items[i].recoverableDep = Math.max(0, Number(e.target.value) || 0);
      refreshAcvCell(i);
    })
  );
  body.querySelectorAll(".nonrec-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      state.items[i].nonRecoverableDep = Math.max(0, Number(e.target.value) || 0);
      refreshAcvCell(i);
    })
  );
  // Adjustment lines: free description, ACV typed directly (no equation), removable.
  body.querySelectorAll(".desc-in").forEach((el) =>
    el.addEventListener("input", (e) => { state.items[Number(e.target.dataset.i)].description = e.target.value; })
  );
  body.querySelectorAll(".acv-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const it = state.items[Number(e.target.dataset.i)];
      it.acvManual = e.target.value === "" ? null : Number(e.target.value) || 0;
      it.acv = itemACV(it);
    })
  );
  body.querySelectorAll(".adj-del").forEach((el) =>
    el.addEventListener("click", (e) => {
      state.items.splice(Number(e.currentTarget.dataset.i), 1);
      renderReview();
    })
  );
  body.querySelectorAll(".rps-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      state.items[i].rps = Math.max(0, Number(e.target.value) || 0);
      refreshAcvCell(i);
    })
  );
  // O&P and Tax are a DECOMPOSITION of RCV (already inside it), so editing them does NOT touch
  // ACV — no refreshAcvCell. They only affect the per-trade O&P/Tax breakdown in the summary.
  body.querySelectorAll(".op-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      state.items[i].op = Math.max(0, Number(e.target.value) || 0);
    })
  );
  body.querySelectorAll(".tax-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      state.items[i].tax = Math.max(0, Number(e.target.value) || 0);
    })
  );

  // Populate the bulk trade select once. A leading "— no change —" sentinel lets an
  // Apply target structure only (and mirrors the bulk structure select).
  const bulk = document.getElementById("bulkTradeSelect");
  if (!bulk.options.length) {
    bulk.innerHTML =
      `<option value="">— no change —</option>` +
      TRADE_ORDER.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  }
  syncStructures(); // populate the bulk structure select + per-row selects + manager
  updateSplitBanner();

  document.getElementById("review").hidden = false;
  hideParsing();
  setLoadedChrome(true);
  syncJobUI(); // reflect any job set in the empty state into the toolbar picker
  // Offset the sticky <thead> so it sits directly below the sticky actions bar.
  const wrap = document.querySelector(".review-table-wrap");
  const actions = wrap.querySelector(".review-actions");
  wrap.style.setProperty("--actions-h", actions.offsetHeight + "px");
  document.getElementById("review").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ------------------------- Grouping + summary ---------------------------- //
function groupByTrade(items) {
  const byTrade = new Map();
  for (const it of items) {
    const t = it.trade || "Not Categorized";
    if (!byTrade.has(t)) byTrade.set(t, []);
    byTrade.get(t).push(it);
  }
  const ordered = TRADE_ORDER.filter((t) => byTrade.has(t));
  const extras = [...byTrade.keys()].filter((t) => !TRADE_ORDER.includes(t)).sort();
  return [...ordered, ...extras].map((t) => {
    const its = byTrade.get(t);
    let rcv = 0, op = 0, tax = 0, recDep = 0, nonRecDep = 0, pwi = 0, rps = 0, acv = 0;
    for (const it of its) {
      const r = Number(it.rcv) || 0;
      const p = Number(it.paidWhenIncurred) || 0;
      const rec = Number(it.recoverableDep) || 0;
      const nr = Number(it.nonRecoverableDep) || 0;
      const cp = Number(it.rps) || 0;
      rcv += r;
      op += Number(it.op) || 0;
      tax += Number(it.tax) || 0;
      recDep += rec;
      nonRecDep += nr;
      pwi += p;
      rps += cp;
      acv += itemACV(it); // one ACV rule everywhere (a typed ACV on an adjustment line wins)
    }
    return {
      trade: t,
      color: TRADE_COLORS[t] || "#94a3b8",
      items: [...its].sort((x, y) => compareLineNumbers(x.displayNumber, y.displayNumber)),
      rcv, op, tax, recDep, nonRecDep, pwi, rps, acv,
    };
  });
}
// True when the claim carries any roof-payment-schedule customer portion — the RPS column is
// shown on the printed tables only then, so claims without it look exactly as before.
const claimHasRps = () => state.items.some((it) => (Number(it.rps) || 0) > 0);

// One "Summary by Trade" table: trade rows + a total row. RCV is the first money column (the
// number the production manager reads first). Per-line O&P/Taxes, when the carrier
// prints them, are summed per trade and shown in those columns (a decomposition of RCV — already
// inside it). Carriers that itemize O&P/Tax only in the summary leave the per-trade cells at "—"
// and carry the value only on the Total row (op/tax passed in). showRows:false omits trade rows —
// used for the compact Claim Total strip (header + total only).
function summaryTableHTML(groups, { op = null, tax = null, totalLabel = "Total", showRows = true } = {}) {
  const dash = dashHTML;
  const t = groups.reduce(
    (a, g) => {
      a.rcv += g.rcv; a.op += g.op || 0; a.tax += g.tax || 0; a.recDep += g.recDep; a.nonRecDep += g.nonRecDep; a.pwi += g.pwi; a.rps += g.rps || 0; a.acv += g.acv;
      return a;
    },
    { rcv: 0, op: 0, tax: 0, recDep: 0, nonRecDep: 0, pwi: 0, rps: 0, acv: 0 }
  );
  const showRps = claimHasRps();
  const rows = !showRows ? "" : groups
    .map(
      (g) => `
      <tr>
        <td class="left"><span class="trade-cell"><span class="trade-swatch" style="background:${g.color}"></span>${esc(g.trade)}</span></td>
        <td>${fmtUSD(g.rcv)}</td>
        <td>${g.op > 0 ? fmtUSD(g.op) : dash}</td>
        <td>${g.tax > 0 ? fmtUSD(g.tax) : dash}</td>
        <td>${g.pwi > 0 ? fmtUSD(g.pwi) : dash}</td>
        <td>${fmtUSD(g.recDep)}</td>
        <td>${fmtUSD(g.nonRecDep)}</td>
        ${showRps ? `<td>${g.rps > 0 ? fmtUSD(g.rps) : dash}</td>` : ""}
        <td>${fmtUSD(g.acv)}</td>
      </tr>`
    )
    .join("");
  return `
      <table class="summary">
        <thead><tr>
          <th class="left">Trade</th><th>RCV</th><th>O&amp;P</th><th>Taxes</th>
          <th>Paid When Incurred</th><th>Recoverable Dep.</th><th>Non-Rec. Dep.</th>${showRps ? "<th>RPS Customer Portion</th>" : ""}<th>ACV</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td class="left">${esc(totalLabel)}</td>
          <td>${fmtUSD(t.rcv)}</td>
          <td>${op != null ? fmtUSD(op) : (t.op > 0 ? fmtUSD(t.op) : dash)}</td>
          <td>${tax != null ? fmtUSD(tax) : (t.tax > 0 ? fmtUSD(t.tax) : dash)}</td>
          <td>${t.pwi > 0 ? fmtUSD(t.pwi) : dash}</td>
          <td>${fmtUSD(t.recDep)}</td>
          <td>${fmtUSD(t.nonRecDep)}</td>
          ${showRps ? `<td>${fmtUSD(t.rps)}</td>` : ""}
          <td>${fmtUSD(t.acv)}</td>
        </tr></tfoot>
      </table>`;
}

// ---------------------- Trade detail pagination --------------------------- //
// The divider pages advertise real printed page ranges, so every .page section MUST render
// as exactly one sheet — a long trade is split into multiple .page sections instead of
// spilling. A fixed row-count cap can't do that honestly: measured rows run 31px (one line)
// to ~96px (wrapped description), so 21 tall rows overflow a sheet that fits 26 short ones.
// Instead each trade's rows are probe-rendered at the exact print content width (7.5in —
// which the screen .page now shares, so measured heights transfer 1:1) and packed into
// pages by their real heights.

// Printable height of a letter sheet in CSS px: 11in − 2×0.5in @page margins = 10in, minus
// the .page print bottom padding (0.2in).
const PRINT_USABLE_PX = (10 - 0.2) * 96; // 940.8
// Safety slack per page: a chunk re-renders with a subset of rows, so auto table-layout can
// redistribute columns slightly and re-wrap one description (±1 line ≈ 17px). 40px absorbs
// two such shifts before a row could cross onto the next sheet.
const PAGE_SLACK = 40;

// Pack row heights (px) into consecutive chunks, each chunk's budget supplied per chunk
// index (first page has a taller header than "(cont.)" pages). A row taller than its whole
// budget gets a page of its own. Pure — unit-tested by the node harness.
function packRowsByHeight(rowHeights, budgetForChunk) {
  const chunks = [];
  let cur = [], used = 0;
  for (let i = 0; i < rowHeights.length; i++) {
    const h = rowHeights[i];
    if (cur.length && used + h > budgetForChunk(chunks.length)) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(i);
    used += h;
  }
  if (cur.length) chunks.push(cur);
  return chunks; // arrays of row indices
}

// Measure-and-pack every trade group: render each trade's FULL table in an off-screen probe
// at the print content width, read the real header/thead/tfoot/row heights, and pack rows
// into per-page chunks. Returns, per group, an array of item-arrays (one per printed page).
function paginateGroups(groups) {
  const probe = document.createElement("div");
  // 818px = 7.5in content + 2×0.5in .page padding + 2px border → .page content box = 720px,
  // identical to both the on-screen sheet and the printed one.
  probe.style.cssText = "position:absolute;left:-9999px;top:0;width:818px;visibility:hidden";
  document.body.appendChild(probe);
  const wrap = (html) => `<main class="doc" style="max-width:none;margin:0;padding:0">${html}</main>`;
  const out = groups.map((g) => {
    probe.innerHTML = wrap(tradeDetailPageHTML(g, g.items, { cont: false, last: true }));
    const table = probe.querySelector("table.lines");
    const headFirst = probe.querySelector(".trade-page-head").offsetHeight;
    const theadH = table.querySelector("thead").offsetHeight;
    const tfootH = table.querySelector("tfoot").offsetHeight;
    const tableMargin = parseFloat(getComputedStyle(table).marginTop) || 0;
    const rowHs = [...table.querySelectorAll("tbody tr")].map((tr) => tr.offsetHeight);
    probe.innerHTML = wrap(tradeDetailPageHTML(g, [], { cont: true, last: false }));
    const headCont = probe.querySelector(".trade-page-head").offsetHeight;
    // tfoot height is reserved on EVERY page (only the last actually renders it) — being a
    // row short on continuation pages is cheaper than a spilled sheet breaking the ranges.
    const budget = (ci) =>
      PRINT_USABLE_PX - (ci === 0 ? headFirst : headCont) - tableMargin - theadH - tfootH - PAGE_SLACK;
    return packRowsByHeight(rowHs, budget).map((idxs) => idxs.map((i) => g.items[i]));
  });
  probe.remove();
  return out;
}

// Printed-sheet bookkeeping for the multi-structure document. Sections map 1:1 to sheets:
// the summary occupies `summaryPages` sheets (a 5-structure summary needs more than one —
// assuming exactly 1 silently shifted every divider range when it spilled in print); each
// structure then contributes a divider sheet followed by one sheet per trade chunk. Input:
// per structure, the array of its trades' chunk counts. Returns [{ start, end, label }]
// aligned with the input — label is the divider's printed range ("Pages: 3–5", or singular
// "Page: 3"). Pure — unit-tested by the node harness.
function computePageRanges(chunkCountsByStructure, summaryPages = 1) {
  let page = summaryPages; // sheets occupied by the summary section(s)
  return chunkCountsByStructure.map((counts) => {
    page += 1; // this structure's divider sheet
    const start = page + 1;
    page += counts.reduce((a, n) => a + n, 0);
    const end = page;
    return { start, end, label: start === end ? `Page: ${start}` : `Pages: ${start}–${end}` };
  });
}

// Split the multi-structure summary across as many printed sheets as its measured height
// requires. Blocks (the Claim Total section, then each structure section) never split
// internally — they pack whole onto sheets via the same height-packing as trade pages.
// Every emitted element is wrapped in a BFC div (.sum-headmeta / .sum-block, overflow:
// hidden in CSS) so child margins are contained and the probe's offsetHeight equals the
// printed extent exactly. Returns { pagesHTML, sheets }.
function paginateSummary(headMetaHTML, blocks) {
  const probe = document.createElement("div");
  // Same probe geometry as paginateGroups: page content box = 720px = one printed sheet.
  probe.style.cssText = "position:absolute;left:-9999px;top:0;width:818px;visibility:hidden";
  document.body.appendChild(probe);
  probe.innerHTML =
    `<main class="doc" style="max-width:none;margin:0;padding:0"><section class="page">${BRAND_ROW}` +
    `<div class="sum-headmeta">${headMetaHTML}</div>` +
    blocks.map((b) => `<div class="sum-block">${b}</div>`).join("") +
    `</section></main>`;
  const headH = probe.querySelector(".sum-headmeta").offsetHeight;
  const brandH = probe.querySelector(".page-brand").offsetHeight; // continuation pages carry only the logo
  const blockHs = [...probe.querySelectorAll(".sum-block")].map((el) => el.offsetHeight);
  probe.remove();
  const chunks = packRowsByHeight(
    blockHs,
    (ci) => PRINT_USABLE_PX - (ci === 0 ? headH : brandH) - PAGE_SLACK
  );
  const pagesHTML = chunks
    .map(
      (idxs, ci) =>
        `<section class="page">` +
        (ci === 0 ? `<div class="sum-headmeta">${headMetaHTML}</div>` : BRAND_ROW) +
        idxs.map((i) => `<div class="sum-block">${blocks[i]}</div>`).join("") +
        `</section>`
    )
    .join("");
  return { pagesHTML, sheets: chunks.length };
}

// All printable pages for a list of trade groups, using the measured chunks from
// paginateGroups so each .page section is one printed sheet.
function tradePagesHTML(groups, chunksByGroup) {
  return groups
    .map((g, gi) => {
      const chunks = chunksByGroup[gi];
      return chunks
        .map((c, ci) => tradeDetailPageHTML(g, c, { cont: ci > 0, last: ci === chunks.length - 1 }))
        .join("");
    })
    .join("");
}

// One printable page of a trade's line items. Continuation pages (a long trade split by
// ROWS_PER_PAGE) carry a "(cont.)" title and no totals strip; the trade-total footer row
// appears only on the last page so it sums the WHOLE trade exactly once.
function tradeDetailPageHTML(g, pageItems, { cont = false, last = true } = {}) {
  const dash = dashHTML;
  const showRps = claimHasRps();
  const rows = pageItems
    .map((it) => {
      const recAmt = Number(it.recoverableDep) || 0;
      const nrAmt = Number(it.nonRecoverableDep) || 0;
      const rpsAmt = Number(it.rps) || 0;
      const rcv = Number(it.rcv) || 0;
      const pwiAmt = Number(it.paidWhenIncurred) || 0;
      const tag = pwiAmt > 0
        ? '<span class="pwi-tag">PAID WHEN INCURRED</span>'
        : nrAmt > 0 ? '<span class="nr-tag">NON-REC</span>' : "";
      return `
            <tr${pwiAmt > 0 ? ' class="pwi-row"' : ""}>
              <td class="num">${esc(it.displayNumber)}</td>
              <td class="left desc">${esc(it.description)}${tag}</td>
              <td class="left">${esc(it.quantity)}</td>
              <td>${fmtUSD(rcv)}</td>
              <td>${pwiAmt > 0 ? fmtUSD(pwiAmt) : dash}</td>
              <td>${recAmt > 0 ? fmtUSD(recAmt) : dash}</td>
              <td>${nrAmt > 0 ? fmtUSD(nrAmt) : dash}</td>
              ${showRps ? `<td>${rpsAmt > 0 ? fmtUSD(rpsAmt) : dash}</td>` : ""}
              <td>${fmtUSD(itemACV(it))}</td>
            </tr>`;
    })
    .join("");
  const totals = cont
    ? ""
    : `
            <div class="trade-page-totals">
              <div class="tpt"><div class="k">RCV</div><div class="v">${fmtUSD(g.rcv)}</div></div>
              ${g.pwi > 0 ? `<div class="tpt"><div class="k">Paid When Incurred</div><div class="v">${fmtUSD(g.pwi)}</div></div>` : ""}
              <div class="tpt"><div class="k">Recoverable Dep.</div><div class="v">${fmtUSD(g.recDep)}</div></div>
              <div class="tpt"><div class="k">ACV</div><div class="v">${fmtUSD(g.acv)}</div></div>
            </div>`;
  const tfoot = !last
    ? ""
    : `
            <tfoot><tr>
              <td class="left" colspan="3">${esc(g.trade)} total (${g.items.length} line${g.items.length === 1 ? "" : "s"})</td>
              <td>${fmtUSD(g.rcv)}</td><td>${g.pwi > 0 ? fmtUSD(g.pwi) : dash}</td><td>${fmtUSD(g.recDep)}</td><td>${fmtUSD(g.nonRecDep)}</td>${showRps ? `<td>${fmtUSD(g.rps)}</td>` : ""}<td>${fmtUSD(g.acv)}</td>
            </tr></tfoot>`;
  return `
        <section class="page">
          <div class="trade-page-head">
            <div class="trade-page-title"><span class="bar" style="background:${g.color}"></span><h2>${esc(g.trade)}${cont ? ' <span class="cont-tag">(cont.)</span>' : ""}</h2></div>${totals}${LOGO_HTML}
          </div>
          <table class="lines">
            <thead><tr>
              <th class="left">Line&nbsp;#</th><th class="left">Description</th><th class="left">Quantity</th>
              <th>RCV</th><th>Paid When Incurred</th><th>Recoverable Dep.</th><th>Non-Rec. Dep.</th>${showRps ? "<th>RPS Cust. Portion</th>" : ""}<th>ACV</th>
            </tr></thead>
            <tbody>${rows}</tbody>${tfoot}
          </table>
        </section>`;
}

function renderDoc() {
  const items = state.items;
  const md = state.summary || {};

  const totalOP = md.totalOP != null ? Number(md.totalOP) : null;
  const totalTax = md.totalTax != null ? Number(md.totalTax) : null;

  // Structures that actually have lines. When ≤1, render exactly as before — no headings,
  // no Claim Total, no divider pages (don't add ceremony for a single structure).
  const usedStructures = (state.structures || []).filter((s) => items.some((it) => it.structureId === s.id));
  const multi = usedStructures.length > 1;

  const job = state.jobInfo;
  // Header block, 3 rows × 2 columns. Left: who/when. Right: what the insurance pays, computed
  // from THIS sheet's own totals (the Total row of the claim-wide table) so the header always
  // ties to the table beneath it:
  //   Total Insurance Pays Homeowner = ACV + Recoverable Dep. − Deductible
  //     (= RCV − Non-Recoverable Dep. − RPS customer portion − Paid When Incurred − Deductible while
  //      every line follows the formula; ACV-based so a typed ACV on an adjustment line counts)
  //   1st Payment (ACV check)        = ACV − Deductible
  // where ACV already nets PWI and both depreciation buckets (same formula everywhere).
  // Deductible is the claim's stated deductible (0 when the parser did not find one).
  const claimTotals = groupByTrade(items).reduce(
    (a, g) => { a.rcv += g.rcv; a.recDep += g.recDep; a.nonRecDep += g.nonRecDep; a.pwi += g.pwi; a.rps += g.rps || 0; a.acv += g.acv; return a; },
    { rcv: 0, recDep: 0, nonRecDep: 0, pwi: 0, rps: 0, acv: 0 }
  );
  const deductible = md.deductible != null ? Number(md.deductible) || 0 : 0;
  const insurancePays = claimTotals.acv + claimTotals.recDep - deductible;
  const firstPayment = claimTotals.acv - deductible;
  // Rendered row-major into a 2-column grid: [left, right] per row.
  const metaRows = [
    ["Job #", job && job.job_number != null ? String(job.job_number) : "—"],
    ["Deductible", md.deductible != null ? fmtUSD(md.deductible) : "—"],
    ["Client Name", (job && job.contact_name) || "—"],
    ["Total Insurance Pays Homeowner", fmtUSD(insurancePays)],
    ["Date Printed", new Date().toLocaleDateString("en-US")],
    ["1st Payment (ACV − Deductible)", fmtUSD(firstPayment)],
  ];

  // ---------- SUMMARY PAGES ----------
  // Multi-structure order: Claim Total FIRST (full per-trade table aggregated across ALL
  // structures — O&P/Taxes on its TOTAL row only), then the per-structure sections. The
  // summary is split across as many .page sections as its measured height needs, so the
  // divider page ranges stay true (a 5-structure summary does not fit one sheet).
  // Single-structure: one page, one table — that lone table IS the claim total.
  const headMeta = `
      <div class="doc-head">${LOGO_HTML}
        <p class="doc-eyebrow">Insurance Claim · Trade Breakdown</p>
        <h1 class="doc-title">Claim Summary by Trade</h1>
        <p class="doc-sub">${esc(md.insurance_company || "")}${md.insurance_company && md.date_of_loss ? " · " : ""}${md.date_of_loss ? "Loss dated " + esc(md.date_of_loss) : ""}</p>
      </div>

      <div class="meta-grid">
        ${metaRows.map(([k, v], i) => `<div class="meta-item${i % 2 ? " meta-pay" : ""}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}
      </div>`;

  let summaryPagesHTML;
  let summarySheets = 1;
  if (!multi) {
    summaryPagesHTML = `
    <section class="page">
      ${headMeta}
      <p class="section-label">Summary by Trade</p>
      ${summaryTableHTML(groupByTrade(items), { op: totalOP, tax: totalTax })}
    </section>`;
  } else {
    const claimTotalBlock =
      `<div class="struct-summary-head claim-total-head">Claim Total</div>` +
      `<p class="section-label">Summary by Trade</p>` +
      summaryTableHTML(groupByTrade(items), { op: totalOP, tax: totalTax });
    const structureBlocks = usedStructures.map((s) => {
      const its = items.filter((it) => it.structureId === s.id);
      return (
        `<div class="struct-summary-head">${esc(s.name)}</div>` +
        `<p class="section-label">Summary by Trade</p>` +
        summaryTableHTML(groupByTrade(its), { op: null, tax: null })
      );
    });
    const paged = paginateSummary(headMeta, [claimTotalBlock, ...structureBlocks]);
    summaryPagesHTML = paged.pagesHTML;
    summarySheets = paged.sheets;
  }

  // ---------- Detail pages: one sheet per trade chunk, under a structure divider when >1 ----------
  // Long trades are split across multiple .page sections by MEASURED row heights so sections
  // map 1:1 to printed sheets — that mapping is what makes the dividers' page ranges true.
  let detailPages;
  if (!multi) {
    const groups = groupByTrade(items);
    detailPages = tradePagesHTML(groups, paginateGroups(groups));
  } else {
    const perStructure = usedStructures.map((s) => {
      const groups = groupByTrade(items.filter((it) => it.structureId === s.id));
      return { s, groups, chunks: paginateGroups(groups) };
    });
    const ranges = computePageRanges(
      perStructure.map((p) => p.chunks.map((c) => c.length)),
      summarySheets
    );
    detailPages = perStructure
      .map((p, si) => {
        // Cover page: the structure name IS the page, with the printed range of its trade sheets.
        const divider = `
        <section class="page structure-divider">${BRAND_ROW}
          <h2 class="sd-name">${esc(p.s.name)}</h2>
          <p class="sd-pages">${esc(ranges[si].label)}</p>
        </section>`;
        return divider + tradePagesHTML(p.groups, p.chunks);
      })
      .join("");
  }

  const docEl = document.getElementById("doc");
  docEl.innerHTML = summaryPagesHTML + detailPages;
  document.title = "Claim Breakdown by Trade";

  // Show the built pages in a modal overlay; the body scrolls if multi-page.
  const modal = document.getElementById("summaryModal");
  modal.hidden = false;
  modal.querySelector(".modal-body").scrollTop = 0;
}

function closeSummaryModal() {
  document.getElementById("summaryModal").hidden = true;
}

// Renders the bundled example so you can see the output with no API call.
async function loadSample() {
  setStatus("Loading sample…");
  try {
    const res = await fetch("sample-data.json");
    const data = await res.json();
    const group = data.final || data.initial || data;
    const src = group.items || [];
    const items = src.map((it) => {
      const rcv = Number(it.rcv) || 0;
      const dep = Number(it.depreciation) || 0;
      // Sample data carries a trusted per-line type (no undetermined-split case here).
      const nonRecoverableDep = it.depreciationType === "non-recoverable" ? dep : 0;
      const recoverableDep = dep - nonRecoverableDep;
      // The fixture marks a struck line with `paidWhenIncurred: true`; its carve-out amount is
      // the line's OWN rcv (so ACV nets to 0 no matter the fixture's RCV). A numeric value is
      // honored as-is, mirroring what the real parser sends.
      const paidWhenIncurred = it.paidWhenIncurred === true ? rcv : (Number(it.paidWhenIncurred) || 0);
      return {
        number: it.number != null ? String(it.number) : "",
        section: it.section || "",
        description: it.description || "",
        quantity: it.quantity || "",
        rcv,
        // Per-line O&P/Tax decomposition (see real-parse mapper). Present in sample-data.json.
        op: Number(it.op) || 0,
        tax: Number(it.tax) || 0,
        recoverableDep,
        nonRecoverableDep,
        rps: Math.max(0, Number(it.rpsCustomerPortion) || 0),
        paidWhenIncurred,
        acv: rcv - paidWhenIncurred - recoverableDep - nonRecoverableDep - Math.max(0, Number(it.rpsCustomerPortion) || 0),
        trade: "Not Categorized", // start uncategorized, like a real parse
      };
    });
    assignDisplayNumbers(items);
    const m = group.metadata || {};
    const sumOP = src.reduce((s, it) => s + (Number(it.op) || 0), 0);
    const sumTax = src.reduce((s, it) => s + (Number(it.tax) || 0), 0);
    // Mutate in place so state.jobInfo (linked Job #) is preserved.
    state.items = items;
    state.summary = {
      insurance_company: m.insurance_company,
      claim_number: m.claim_number,
      date_of_loss: m.claim_date || m.date_of_loss,
      deductible: m.deductible,
      totalOP: m.total_op != null ? m.total_op : (sumOP || null),
      totalTax: m.total_tax != null ? m.total_tax : (sumTax || null),
    };
    state.splitUndetermined = false;
    initStructures(); // one "Structure 1", every line assigned to it
    renderReview();
    setStatus(`Loaded sample: ${items.length} line items. All start “Not Categorized” — select and assign trades, then Build summary.`, "ok");
  } catch {
    setStatus("Could not load sample-data.json (serve the folder over HTTP, not file://).", "error");
  }
}


// --------------------------- SFC Estimate --------------------------------- //
// "Build SFC Estimate": a full-screen walk the production manager takes after the lines are
// categorized. Rates come from SFC's live cost history (the OI platform's
// /api/analytics/live-pricing — the same medians the Live Pricing page shows).
//
//   Trades         one screen per trade: every line with RCV / Rec / Non-Rec / ACV and a
//                  "Credit ACV" box (+ "Credit entire trade"). A credited line is NOT contracted:
//                  its RCV leaves the job and its ACV joins the ACV credits — the homeowner's
//                  insurance money for work we are not doing.
//   Pricing        measurement or bid per contracted trade (Measure | Bid switch), upgrades,
//                  marketing credits, client, deductible.
//   Estimate       four printed pages: 1 Claim Summary by Trade (page 1 of the breakdown),
//                  2 Preliminary Pricing (scope + out-of-pocket, signatures), 3 How Insurance
//                  Pays You (ACV, recoverable depreciation), 4 ACV Credits.
//
// Money model (every page ties to it):
//   Contracted Amount (trade) = contracted RCV + upgrades
//   Total job value           = Σ Contracted Amount − marketing credits
//   Insurance pays            = ACV on EVERY line − deductible (first check)
//                             + recoverable dep (+ paid-when-incurred) on contracted lines
//   Out-of-pocket             = job value − insurance pays
//                             = deductible + upgrades + non-rec dep
//                               + RPS customer portion − ACV credits − marketing
//   (negative out-of-pocket = a credit back to the homeowner)
const SFC_TRADE_UOM = { ROOF: "SQ", SIDING: "SF", STUCCO: "SF", GUTTERS: "LF", PAINT: "SF", WINDOWS: "EA", FENCE: "LF", GARAGE: "SF", SOLAR: "PNL" };
const SFC_MIN_JOBS = 3; // fewer measured jobs than this → "no SFC rate yet"
// Bid trades: no usable history, the estimator types SFC's cost. Any trade can be switched.
const SFC_BID_TRADES = new Set(["WINDOWS", "GARAGE", "SOLAR", "PAINT"]);
const SFC_MARKETING_TYPES = ["Yard sign", "Referral", "Review", "Veteran discount"];
const SFC_TARGET_MARGIN = 33; // required gross margin, % of revenue
// Other job costs (every COGS line that is not labor or materials) are a flat 21% of the net
// contracted amount — never per square (Yash's rule, 2026-09-28; history says 20.5%).
const SFC_OTHER_PCT = 21;
// Homeowner-facing names for the trades on the scope of work.
const SFC_TRADE_SERVICE = {
  ROOF: "Roofing Services", GUTTERS: "Gutter Services", SIDING: "Siding Services", STUCCO: "Stucco Services", WINDOWS: "Window Services",
  PAINT: "Painting Services", SOLAR: "Solar Services", FENCE: "Fence Services", GARAGE: "Garage Services",
  MISC: "Miscellaneous", "PERSONAL PROPERTY": "Personal Property", "PRICE ADJUSTMENT": "Price Adjustment",
};
const sfcServiceName = (t) =>
  SFC_TRADE_SERVICE[t] || `${String(t).toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase())} Services`;

// ---- price list: SFC cost levers + fixed upgrade prices ----
// Yash's rule (2026-10-19): production managers price from THIS list, not from median margins.
// "cost" is what the work costs SFC per unit; an upgrade's "price" is what the homeowner is
// charged per unit — never typed, only the quantity is. Editable in the Price list panel
// (saved in this browser; Reset restores these defaults). Shingle roofs only for now.
const PRICE_LIST_VERSION = 2;
const PRICE_LIST_KEY = "sfc-claim-breakdown.priceList.v2";
// Every trade that can be priced has an entry; trades without structured assumptions are bid
// pricing only but can still carry upgrades the owner adds on the price list page.
const PRICEABLE_TRADES = Object.keys(SFC_TRADE_UOM);
const PRICE_LIST_DEFAULT = {
  ROOF: {
    // Install cost per square by shingle class. Shingle roofs are ASSUMED the base class
    // (Class 3, 2026-10-19); the Class 4 upgrade adds that class's cost difference per square.
    shingles: [
      { key: "class3", label: "Class 3 shingle (base)", cost: 380, base: true },
      { key: "class4", label: "Class 4 shingle", cost: 425 },
    ],
    // Steep slope: squares at fromPitch/12 or steeper cost this much more per square.
    steep: { fromPitch: 8, cost: 30 },
    redecking: { cost: 80 },
    // Upgrades charged to the homeowner. costIn = the SFC cost already sits in that assumption
    // above (so the upgrade adds price, not cost). classKey = cost is that class minus base.
    upgrades: [
      { key: "class4", label: "Class 4 Upgrade", unit: "SQ", price: 125, classKey: "class4", qtyFrom: "shingle" },
      { key: "redecking", label: "Redecking", unit: "SQ", price: 120, cost: 0, costIn: "redecking", qtyFrom: "redecking" },
      { key: "ridgevent", label: "Ridge Vent Installation", unit: "LF", price: 20, cost: 10 },
      { key: "warranty", label: "Warranty (Tamko)", unit: "SQ", price: 200, cost: 75, qtyFrom: "total" },
      { key: "iws", label: "Full IWS", unit: "SQ", price: 80, cost: 40, qtyFrom: "total" },
    ],
  },
  // Gutters: cost per LF of gutter + downspout by material, plus adders for 6" and painting.
  GUTTERS: {
    types: [{ key: "steel", label: "Steel", cost: 10 }, { key: "aluminum", label: "Aluminum", cost: 6 }],
    sixInch: { cost: 1 },
    paint: { cost: 1 },
    upgrades: [],
  },
  // Siding: cost per SF for the types on the list; every other type needs management's bid.
  SIDING: {
    types: [
      { key: "vinyl", label: "Vinyl (Standard)", cost: 5.5 },
      { key: "hardie", label: "Hardie Board", cost: 9.5 },
      { key: "lp", label: "LP SmartSide (engineered wood)", bid: true },
      { key: "wood", label: "Wood / cedar", bid: true },
      { key: "steel", label: "Steel / metal siding", bid: true },
      { key: "boardbatten", label: "Board & batten", bid: true },
      { key: "stone", label: "Stone / brick veneer", bid: true },
      { key: "other", label: "Other", bid: true },
    ],
    upgrades: [],
  },
};
function priceListClone() {
  const b = JSON.parse(JSON.stringify(PRICE_LIST_DEFAULT));
  for (const t of PRICEABLE_TRADES) { b[t] = b[t] || {}; b[t].upgrades = b[t].upgrades || []; b[t].costs = b[t].costs || []; }
  return b;
}
// Saved overrides laid over the defaults, so new list entries still show up later. Per trade:
// { upgrades: { key: { price, cost, label, unit } }, added: [custom upgrades], removed: [keys] }.
function priceListApply(base, o) {
  const num = (v, d) => (v == null || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
  const R = o.ROOF || {};
  for (const sh of base.ROOF.shingles) if (R.shingles && R.shingles[sh.key] != null) sh.cost = num(R.shingles[sh.key], sh.cost);
  if (R.steep) { base.ROOF.steep.fromPitch = num(R.steep.fromPitch, base.ROOF.steep.fromPitch); base.ROOF.steep.cost = num(R.steep.cost, base.ROOF.steep.cost); }
  if (R.redecking) base.ROOF.redecking.cost = num(R.redecking.cost, base.ROOF.redecking.cost);
  const G = o.GUTTERS || {};
  for (const t of base.GUTTERS.types) if (G.types && G.types[t.key] != null) t.cost = num(G.types[t.key], t.cost);
  if (G.sixInch) base.GUTTERS.sixInch.cost = num(G.sixInch.cost, base.GUTTERS.sixInch.cost);
  if (G.paint) base.GUTTERS.paint.cost = num(G.paint.cost, base.GUTTERS.paint.cost);
  const S = o.SIDING || {};
  for (const t of base.SIDING.types) if (!t.bid && S.types && S.types[t.key] != null) t.cost = num(S.types[t.key], t.cost);
  for (const t of PRICEABLE_TRADES) {
    const T = o[t] || {};
    for (const u of base[t].upgrades) {
      const x = T.upgrades && T.upgrades[u.key];
      if (!x) continue;
      u.price = num(x.price, u.price);
      if (!u.classKey && !u.costIn) u.cost = num(x.cost, u.cost);
      if (x.label) u.label = String(x.label);
      if (x.unit) u.unit = String(x.unit);
    }
    for (const a of T.added || []) {
      if (a && a.key) base[t].upgrades.push({ key: String(a.key), label: String(a.label || "Upgrade"), unit: String(a.unit || SFC_TRADE_UOM[t] || "EA"), price: num(a.price, 0), cost: num(a.cost, 0), custom: true });
    }
    const rm = new Set(T.removed || []);
    base[t].upgrades = base[t].upgrades.filter((u) => !rm.has(u.key));
    // Cost items are all owner-added: what SFC pays per unit, asked for by quantity on the
    // trade's Assumptions page.
    base[t].costs = (T.costs || []).filter((c) => c && c.key).map((c) => ({ key: String(c.key), label: String(c.label || "Cost item"), unit: String(c.unit || SFC_TRADE_UOM[t] || "EA"), cost: num(c.cost, 0) }));
  }
}
function priceListLoad() {
  const base = priceListClone();
  try { const saved = JSON.parse(localStorage.getItem(PRICE_LIST_KEY) || "null"); if (saved && saved.version) priceListApply(base, saved); } catch (_) { /* defaults */ }
  return base;
}
function priceListOverrides(L) {
  const o = { version: PRICE_LIST_VERSION, ROOF: {
    shingles: Object.fromEntries(L.ROOF.shingles.map((sh) => [sh.key, sh.cost])),
    steep: { ...L.ROOF.steep }, redecking: { ...L.ROOF.redecking },
  }, GUTTERS: {
    types: Object.fromEntries(L.GUTTERS.types.map((t) => [t.key, t.cost])),
    sixInch: { ...L.GUTTERS.sixInch }, paint: { ...L.GUTTERS.paint },
  }, SIDING: {
    types: Object.fromEntries(L.SIDING.types.filter((t) => !t.bid).map((t) => [t.key, t.cost])),
  } };
  for (const t of PRICEABLE_TRADES) {
    const defaults = (PRICE_LIST_DEFAULT[t] && PRICE_LIST_DEFAULT[t].upgrades) || [];
    const ups = (L[t] && L[t].upgrades) || [];
    o[t] = o[t] || {};
    o[t].upgrades = Object.fromEntries(ups.filter((u) => !u.custom).map((u) => [u.key, { price: u.price, cost: u.cost, label: u.label, unit: u.unit }]));
    o[t].added = ups.filter((u) => u.custom).map((u) => ({ key: u.key, label: u.label, unit: u.unit, price: u.price, cost: u.cost }));
    o[t].removed = defaults.filter((d) => !ups.some((u) => u.key === d.key)).map((d) => d.key);
    o[t].costs = ((L[t] && L[t].costs) || []).map((c) => ({ key: c.key, label: c.label, unit: c.unit, cost: c.cost }));
  }
  return o;
}
let priceList = priceListLoad();
function priceListSave(L) { priceList = L; try { localStorage.setItem(PRICE_LIST_KEY, JSON.stringify(priceListOverrides(L))); } catch (_) { /* private mode */ } }
function priceListReset() { priceList = priceListClone(); try { localStorage.removeItem(PRICE_LIST_KEY); } catch (_) { /* private mode */ } }
const sfcHasPriceList = (trade) => !!priceList[trade];
// Roof types the assumptions page offers. Shingles price from the list at the lowest class
// (upgrades raise it); tile, metal and modbit are not on it — bid before pricing.
const ROOF_TYPES = [
  { key: "shingle", label: "Shingles" },
  { key: "tile", label: "Tile", bid: true },
  { key: "metal", label: "Metal", bid: true },
  { key: "modbit", label: "Modbit", bid: true },
];
const roofTypeSpec = (key) => ROOF_TYPES.find((t) => t.key === key) || { key, label: key };
// roof.types = [{ key, sq }] in the order they were added. steepSq / walkSq: squares at the
// steep pitch or steeper, and under it (pitch can differ across a roof).
const sfcRoofDefaults = () => ({ types: [], steepSq: null, walkSq: null, redeck: false, redeckSq: null });
const sfcRoofTypes = () => ((sfc.roof && sfc.roof.types) || []);
const sfcRoofNeedsBid = () => sfcRoofTypes().some((t) => roofTypeSpec(t.key).bid);
// A bid-required type with no estimated cost typed yet — the walk cannot move past Assumptions.
const sfcRoofBidMissing = () => sfcRoofTypes().some((t) => roofTypeSpec(t.key).bid && !(Number(t.bid) > 0));
const sfcRoofTotalSq = () => Math.round(sfcRoofTypes().reduce((a, t) => a + Math.max(0, Number(t.sq) || 0), 0) * 100) / 100;
const sfcRoofSqOf = (key) => sfcRoofTypes().filter((t) => t.key === key).reduce((a, t) => a + Math.max(0, Number(t.sq) || 0), 0);
// The lowest shingle class on the list — what every shingle roof is assumed to be.
const sfcShingleBase = () => priceList.ROOF.shingles.find((sh) => sh.base) || priceList.ROOF.shingles[0];
// Per-unit SFC cost of a list upgrade: a class upgrade costs the class's difference over base.
function sfcUpgradeUnitCost(spec) {
  if (!spec.classKey) return Number(spec.cost) || 0;
  const cls = priceList.ROOF.shingles.find((sh) => sh.key === spec.classKey);
  return cls ? Math.max(0, cls.cost - sfcShingleBase().cost) : 0;
}
// Roof assumptions → SFC cost. Shingle squares price from the list (base class + steep +
// redecking); tile / metal / modbit cost whatever management estimated on the assumptions
// page. null until something is priced, or while a bid-required type has no cost yet.
function sfcRoofCost() {
  const L = priceList.ROOF, r = sfc.roof || sfcRoofDefaults();
  if (sfcRoofBidMissing()) return null;
  const sqOf = (k) => Math.max(0, Number(r[k]) || 0);
  const base = sfcShingleBase();
  const sq = sfcRoofTotalSq();
  const shingleSq = sfcRoofSqOf("shingle");
  const parts = [];
  if (shingleSq > 0) parts.push({ key: "shingle", label: "Shingles", sq: shingleSq, rate: base.cost, cost: shingleSq * base.cost });
  const steepSq = Math.min(sqOf("steepSq"), sq);
  if (steepSq > 0) parts.push({ key: "steep", label: `Steep (${L.steep.fromPitch}/12+)`, sq: steepSq, rate: L.steep.cost, cost: steepSq * L.steep.cost });
  const redeckSq = r.redeck ? sqOf("redeckSq") : 0;
  if (redeckSq > 0) parts.push({ key: "redecking", label: "Redecking", sq: redeckSq, rate: L.redecking.cost, cost: redeckSq * L.redecking.cost });
  for (const t of sfcRoofTypes()) {
    const spec = roofTypeSpec(t.key);
    if (spec.bid && Number(t.bid) > 0) parts.push({ key: t.key, label: spec.label, sq: Math.max(0, Number(t.sq) || 0), rate: null, cost: Number(t.bid) });
  }
  if (!parts.length) return null;
  const cost = parts.reduce((a, p) => a + p.cost, 0);
  return { sq, steepSq, redeckSq, parts, cost, perSq: sq > 0 ? cost / sq : null };
}
// ---- gutters: type › LF of gutters + downspouts › 5" or 6" › paint ----
const sfcGutterDefaults = () => ({ type: null, gutterLf: null, downLf: null, size: null, paint: null });
function sfcGutterCost() {
  const L = priceList.GUTTERS, g = sfc.gutters || sfcGutterDefaults();
  const t = L.types.find((x) => x.key === g.type);
  if (!t || !g.size || g.paint == null) return null;
  const qty = Math.round(((Number(g.gutterLf) || 0) + (Number(g.downLf) || 0)) * 100) / 100;
  if (!(qty > 0)) return null;
  const rate = t.cost + (g.size === "6" ? L.sixInch.cost : 0) + (g.paint ? L.paint.cost : 0);
  return { qty, rate, cost: qty * rate, parts: [{ label: `${t.label} ${g.size}" gutters${g.paint ? ", painted" : ""}`, qty, rate, cost: qty * rate }] };
}
// ---- siding: type(s) › SF per type (+ management's cost for types not on the list) ----
const sfcSidingDefaults = () => ({ types: [] }); // [{ key, sf, bid }]
const sidingTypeSpec = (key) => priceList.SIDING.types.find((t) => t.key === key) || { key, label: key, bid: true };
const sfcSidingTypes = () => ((sfc.siding && sfc.siding.types) || []);
const sfcSidingNeedsBid = () => sfcSidingTypes().some((t) => sidingTypeSpec(t.key).bid);
const sfcSidingBidMissing = () => sfcSidingTypes().some((t) => sidingTypeSpec(t.key).bid && !(Number(t.bid) > 0));
const sfcSidingTotalSf = () => Math.round(sfcSidingTypes().reduce((a, t) => a + Math.max(0, Number(t.sf) || 0), 0) * 100) / 100;
function sfcSidingCost() {
  if (sfcSidingBidMissing()) return null;
  const parts = [];
  for (const t of sfcSidingTypes()) {
    const spec = sidingTypeSpec(t.key), sf = Math.max(0, Number(t.sf) || 0);
    if (spec.bid) { if (Number(t.bid) > 0) parts.push({ key: t.key, label: spec.label, qty: sf, rate: null, cost: Number(t.bid) }); }
    else if (sf > 0) parts.push({ key: t.key, label: spec.label, qty: sf, rate: spec.cost, cost: sf * spec.cost });
  }
  if (!parts.length) return null;
  const qty = sfcSidingTotalSf();
  return { qty, cost: parts.reduce((a, p) => a + p.cost, 0), parts };
}
// ---- every other priceable trade: bid pricing only — quantity + management's estimated cost ----
function sfcBidCost(trade) {
  const b = Number(sfc.bids[trade]) || 0;
  return b > 0 ? { qty: Number(sfc.measurements[trade]) || null, cost: b, parts: [] } : null;
}
// Owner-added cost items for a trade, priced by the quantities typed on its Assumptions page.
const sfcCostItems = (trade) => ((priceList[trade] && priceList[trade].costs) || []);
function sfcCostItemParts(trade) {
  const q = sfc.costQty[trade] || {};
  return sfcCostItems(trade)
    .map((it) => ({ key: it.key, label: it.label, qty: Math.max(0, Number(q[it.key]) || 0), rate: it.cost, cost: Math.max(0, Number(q[it.key]) || 0) * it.cost }))
    .filter((p) => p.qty > 0);
}
// The SFC cost of a trade from its assumptions: { qty, cost, parts } or null while unpriced.
function sfcTradeCost(trade) {
  if (sfcIsClaimOnly(trade)) return null;
  const extra = sfcCostItemParts(trade);
  const extraCost = extra.reduce((a, p) => a + p.cost, 0);
  let base = null;
  if (trade === "ROOF") { const rc = sfcRoofCost(); base = rc ? { qty: rc.sq, cost: rc.cost, parts: rc.parts } : null; }
  else if (trade === "GUTTERS") base = sfcGutterCost();
  else if (trade === "SIDING") base = sfcSidingCost();
  else {
    // Bid-only trade: management's estimate, and/or the owner's cost items by quantity.
    const b = sfcBidCost(trade);
    if (b) base = b;
    else if (extra.length) base = { qty: Number(sfc.measurements[trade]) || null, cost: 0, parts: [] };
  }
  if (!base) return null;
  return { qty: base.qty, cost: base.cost + extraCost, parts: [...base.parts, ...extra] };
}
// Supplement status, shown left of every trade on Pricing and the Price Snapshot.
const SFC_SUPP_OPTIONS = ["WORK DOING", "WORK NOT DOING", "SUPP. DEPENDING"];
const sfcSuppStatus = (trade, c) => sfc.supp[trade] || (c && c.rcv > 0 ? "WORK DOING" : "WORK NOT DOING");

// Upgrades picked from the list carry a key + quantity; price and cost are computed from the
// list every time they are read, so a price-list edit flows through automatically.
function sfcUpgradeSpec(u) { const L = priceList[u.trade]; return u.key && L ? L.upgrades.find((x) => x.key === u.key) || null : null; }
// Quantities are always typed by the estimator — nothing is pre-filled (Yash, 2026-10-19).
function sfcResolveUpgrade(u) {
  const spec = sfcUpgradeSpec(u); if (!spec) return u;
  const qty = Math.max(0, Number(u.qty) || 0);
  return { ...u, qty, price: qty * spec.price, cost: qty * sfcUpgradeUnitCost(spec), description: `${spec.label}${qty > 0 ? ` (${qty} ${spec.unit})` : ""}` };
}

// credits: lineKey -> true when the line's ACV is credited (line leaves the contracted scope).
// lineKey = the line's index in state.items — stable for one parsed claim; itemsRef remembers
// which claim the state belongs to so a new upload starts clean.
// mode: trade -> "measure" | "bid". unlocked / rateEdits: a history rate is locked at the median
// until the estimator clicks Unlock; the typed $/unit then replaces the median.
let sfc = {
  pricing: null, measurements: {}, bids: {}, unlocked: {}, rateEdits: {}, mode: {}, client: "", perUnit: false,
  rates: null, credits: {}, deductible: null, step: 0, itemsRef: null,
  upgrades: [], marketingCredits: [],
  roof: { types: [], steepSq: null, walkSq: null, redeck: false, redeckSq: null }, // roof assumptions (own step)
  gutters: { type: null, gutterLf: null, downLf: null, size: null, paint: null },
  siding: { types: [] },
  costQty: {}, // trade -> { costItemKey: quantity } for the owner's cost items
  supp: {}, // trade -> supplement status
};
let sfcSeq = 1;

// "28.40 SQ" / "1,234.5 SF" → { value, unit }; null when the quantity has no unit.
function parseQuantity(q) {
  const m = /([\d,]*\.?\d+)\s*([A-Za-z]+)/.exec(String(q || ""));
  if (!m) return null;
  return { value: Number(m[1].replace(/,/g, "")), unit: m[2].toUpperCase() };
}
// Every trade on the claim that carries RCV, in summary order.
function sfcTradeGroups() {
  return groupByTrade(state.items).filter((g) => g.rcv > 0);
}
const sfcIsClaimOnly = (trade) => !SFC_TRADE_UOM[trade];
const fmtRate = (n) => {
  if (n == null) return "—";
  const digits = Math.abs(n) < 20 ? 2 : 0;
  return Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const fmtPct1 = (n) => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}%`);
const money0 = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
const paren = (n) => (n > 0 ? `(${fmtUSD(n)})` : fmtUSD(0));

// ---- lines, credits ----
const sfcLineKey = (it) => state.items.indexOf(it);
const sfcLineACV = (it) => itemACV(it);
const sfcIsCredited = (it) => !!sfc.credits[sfcLineKey(it)];
function sfcSetCredited(it, on) {
  const k = sfcLineKey(it);
  if (on) sfc.credits[k] = true; else delete sfc.credits[k];
}
// Per trade: contracted (non-credited) vs credited figures.
function sfcContracted(g) {
  let rcv = 0, acv = 0, rec = 0, nonRec = 0, pwi = 0, rps = 0, credit = 0, creditRcv = 0, creditRec = 0, credited = 0, contractedCount = 0;
  for (const it of g.items) {
    const r = Number(it.recoverableDep) || 0;
    if (sfcIsCredited(it)) { credit += sfcLineACV(it); creditRcv += Number(it.rcv) || 0; creditRec += r; credited += 1; }
    else {
      rcv += Number(it.rcv) || 0; acv += sfcLineACV(it); rec += r; contractedCount += 1;
      nonRec += Number(it.nonRecoverableDep) || 0; pwi += Number(it.paidWhenIncurred) || 0;
      rps += Number(it.rps) || 0; // roof payment schedule customer portion on contracted lines
    }
  }
  return { rcv, acv, rec, nonRec, pwi, rps, credit, creditRcv, creditRec, credited, contractedCount };
}
function sfcTotalCredits() {
  return state.items.reduce((a, it) => a + (sfcIsCredited(it) ? sfcLineACV(it) : 0), 0);
}
function sfcCreditedLines() {
  return state.items.filter(sfcIsCredited);
}

// ---- upgrades, marketing, contractor pricing ----
function sfcUpgradesFor(trade) {
  return sfc.upgrades.filter((u) => u.trade === trade).map(sfcResolveUpgrade);
}
function sfcMarketingTotal() {
  return sfc.marketingCredits.reduce((a, m) => a + (Number(m.amount) || 0), 0);
}
// Every trade in the job: on the claim with RCV, or carrying an upgrade.
function sfcJobTrades() {
  const claim = sfcTradeGroups();
  const names = new Set(claim.map((g) => g.trade));
  const extra = sfc.upgrades.map((u) => u.trade).filter((t) => t && !names.has(t));
  const order = [...TRADE_ORDER, ...[...new Set(extra)].filter((t) => !TRADE_ORDER.includes(t)).sort()];
  const byName = new Map(claim.map((g) => [g.trade, g]));
  return order
    .filter((t) => byName.has(t) || extra.includes(t))
    .map((t) => byName.get(t) || { trade: t, color: TRADE_COLORS[t] || "#94a3b8", items: [], rcv: 0, acv: 0, recDep: 0, nonRecDep: 0, pwi: 0, op: 0, tax: 0 });
}

// ---- the priced rows every money screen is built from ----
function sfcPriceRows() {
  return sfcJobTrades()
    .map((g) => ({ g, c: sfcContracted(g), ups: sfcUpgradesFor(g.trade) }))
    .filter(({ g, ups }) => g.items.length || ups.length)
    .map(({ g, c, ups }) => {
      const upPrice = ups.reduce((a, u) => a + (Number(u.price) || 0), 0);
      const upCost = ups.reduce((a, u) => a + (Number(u.cost) || 0), 0);
      const contracted = c.rcv + upPrice;
      const uom = SFC_TRADE_UOM[g.trade];
      const tc = c.rcv > 0 ? sfcTradeCost(g.trade) : null; // from the trade's Assumptions step
      const meas = tc && tc.qty > 0 ? tc.qty : sfc.measurements[g.trade];
      let cost = null, priced = false;
      if (c.rcv > 0 && !sfcIsClaimOnly(g.trade)) {
        priced = !!tc;
        cost = priced ? tc.cost + upCost : null;
      } else if (ups.length && upCost > 0) {
        priced = true; cost = upCost;
      }
      const pct = priced && contracted > 0 ? ((contracted - cost) / contracted) * 100 : null;
      return {
        g, c, ups, upPrice, upCost, contracted, uom,
        rcv: c.rcv, acv: c.acv, payRCV: c.rcv + c.creditRcv, payACV: c.acv + c.credit,
        meas: c.rcv > 0 && !sfcIsClaimOnly(g.trade) ? meas : null, priced, cost, pct,
      };
    });
}
// Job-wide money from the rows.
function sfcMoney(rows) {
  const payout = rows.reduce((a, r) => a + r.rcv, 0);
  const payoutACV = rows.reduce((a, r) => a + r.acv, 0);
  const claimRCV = rows.reduce((a, r) => a + r.payRCV, 0);
  const claimACV = rows.reduce((a, r) => a + r.payACV, 0);
  const upgrades = rows.reduce((a, r) => a + r.upPrice, 0);
  const recTotal = rows.reduce((a, r) => a + r.c.rec, 0);
  const pwiTotal = rows.reduce((a, r) => a + r.c.pwi, 0);
  const nonRecTotal = rows.reduce((a, r) => a + r.c.nonRec, 0);
  const rpsTotal = rows.reduce((a, r) => a + r.c.rps, 0);
  const tradeCost = rows.filter((r) => r.priced).reduce((a, r) => a + r.cost, 0);
  const acvCredits = sfcTotalCredits();
  const marketing = sfcMarketingTotal();
  const deductible = sfc.deductible != null ? Number(sfc.deductible) || 0 : 0;
  const jobValue = payout + upgrades - marketing;
  const other = jobValue * (SFC_OTHER_PCT / 100);
  const totalCost = tradeCost + other;
  const netPct = jobValue > 0 ? ((jobValue - totalCost) / jobValue) * 100 : null;
  const insurancePays = claimACV - deductible + recTotal + pwiTotal;
  const outOfPocket = Math.round((jobValue - insurancePays) * 100) / 100; // < 0 → credit back to the homeowner
  return { payout, payoutACV, claimRCV, claimACV, upgrades, recTotal, pwiTotal, nonRecTotal, rpsTotal, tradeCost, acvCredits, marketing, deductible, jobValue, other, totalCost, netPct, insurancePays, outOfPocket };
}

// ---- flow ----
// Steps: one credit screen per trade, one assumptions page per trade we are contracting
// (claim-only and fully credited trades get none), pricing, estimate.
function sfcAssumeTrades() {
  return sfcTradeGroups().filter((g) => !sfcIsClaimOnly(g.trade) && sfcContracted(g).rcv > 0);
}
function sfcSteps() {
  const trades = sfcTradeGroups().map((g) => ({ kind: "trade", g }));
  const assume = sfcAssumeTrades().map((g) => ({ kind: "assume", g }));
  if (!assume.length) assume.push({ kind: "assume", g: null });
  return [...trades, ...assume, { kind: "pricing" }, { kind: "estimate" }];
}
const sfcStepIndex = (kind) => sfcSteps().findIndex((st) => st.kind === kind);
async function openSfcEstimate() {
  if (!state.items.length) return setStatus("Nothing to estimate yet — upload a PDF first.", "error");
  const groups = sfcTradeGroups();
  if (!groups.length) return setStatus("No line items carry RCV yet.", "error");
  if (sfc.itemsRef !== state.items) {
    sfc.itemsRef = state.items;
    sfc.credits = {}; sfc.measurements = {}; sfc.bids = {}; sfc.supp = {}; sfc.costQty = {};
    sfc.deductible = null; sfc.client = ""; sfc.upgrades = []; sfc.marketingCredits = [];
    sfc.roof = sfcRoofDefaults(); sfc.gutters = sfcGutterDefaults(); sfc.siding = sfcSidingDefaults();
  }
  if (!sfc.client && state.jobInfo && state.jobInfo.contact_name) sfc.client = state.jobInfo.contact_name;
  const md = state.summary || {};
  sfc.deductible = md.deductible != null ? Number(md.deductible) || 0 : null; // one shared deductible

  document.getElementById("sfcModal").hidden = false;
  document.body.classList.add("sfc-open");
  sfcBarMode("trade");
  // Costs come from the price list + each trade's assumptions; nothing is pre-filled.
  sfc.step = 0;
  renderSfcStep();
}
function closeSfcModal() {
  document.getElementById("sfcModal").hidden = true;
  document.body.classList.remove("sfc-open");
}
// Step bar in the header: Trades · Pricing · ACV credits · Estimate (earlier steps clickable).
function sfcBarMode(mode) {
  const cur = mode === "trade" ? 0 : mode === "assume" ? 1 : mode === "pricing" ? 2 : 3;
  const labels = ["Trades", "Assumptions", "Pricing", "Estimate"];
  const bar = document.getElementById("sfcSteps");
  if (bar) {
    bar.innerHTML = labels
      .map((l, i) => `<button type="button" class="sfc-stepbtn${i === cur ? " current" : i < cur ? " done" : ""}" data-step="${i}" ${i > cur ? "disabled" : ""}><span class="n">${i + 1}</span>${esc(l)}</button>`)
      .join('<span class="sfc-stepsep">›</span>');
    for (const b of bar.querySelectorAll(".sfc-stepbtn:not([disabled])")) {
      b.addEventListener("click", () => {
        sfc.step = sfcStepIndex(["trade", "assume", "pricing", "estimate"][Number(b.dataset.step)]);
        renderSfcStep();
      });
    }
  }
  document.getElementById("sfcUomBtn").hidden = mode !== "estimate";
  document.getElementById("sfcPrintBtn").hidden = mode !== "estimate";
  document.getElementById("sfcUomBtn").setAttribute("aria-pressed", String(sfc.perUnit));
}
function renderSfcStep() {
  const steps = sfcSteps();
  sfc.step = Math.max(0, Math.min(sfc.step, steps.length - 1));
  const st = steps[sfc.step];
  document.getElementById("sfcModal").querySelector(".modal-body").scrollTop = 0;
  document.getElementById("sfcBody").classList.toggle("sfc-work", st.kind !== "estimate");
  if (st.kind === "trade") {
    const n = sfcTradeGroups().length;
    sfcBarMode("trade"); renderSfcTrade(st.g, sfc.step, n);
  } else if (st.kind === "assume") {
    const all = steps.filter((x) => x.kind === "assume");
    sfcBarMode("assume"); renderSfcAssumptions(st.g, all.indexOf(st) + 1, all.length);
  } else if (st.kind === "pricing") { sfcBarMode("pricing"); renderSfcPricing(); }
  else { sfcBarMode("estimate"); renderSfcEstimate(); }
}
// Shared nav bar on the working screens.
function sfcNavHTML({ step, trade, color, right, prevDisabled = false, nextLabel = "Next →" }) {
  return `
    <div class="sfc-tradenav">
      <button type="button" class="btn btn-nav" id="sfcPrevBtn" ${prevDisabled ? "disabled" : ""} aria-label="Back">←</button>
      <div class="sfc-tradenav-title">
        <span class="sfc-step">${step}</span>
        <span class="trade-cell">${color ? `<span class="trade-swatch" style="background:${color}"></span>` : ""}${esc(trade)}</span>
      </div>
      ${right || "<span></span>"}
      <div class="sfc-tradenav-credits">ACV credits <b id="sfcCreditsSoFar">${fmtUSD(sfcTotalCredits())}</b></div>
      <button type="button" class="btn btn-primary btn-nav" id="sfcNextBtn">${nextLabel}</button>
    </div>`;
}
function sfcWireNav(onPrev, onNext) {
  document.getElementById("sfcPrevBtn").addEventListener("click", () => { if (onPrev) onPrev(); sfc.step -= 1; renderSfcStep(); });
  document.getElementById("sfcNextBtn").addEventListener("click", () => { if (onNext) onNext(); sfc.step += 1; renderSfcStep(); });
  const nav = document.querySelector(".sfc-tradenav");
  document.getElementById("sfcBody").style.setProperty("--navh", `${nav.offsetHeight}px`);
}

// ---- step: one trade's lines ----
function renderSfcTrade(g, idx, n) {
  const dash = dashHTML;
  const showRps = claimHasRps();
  const rowHTML = (it) => {
    const key = sfcLineKey(it);
    const rec = Number(it.recoverableDep) || 0;
    const nr = Number(it.nonRecoverableDep) || 0;
    const cr = sfcIsCredited(it);
    const cp = Number(it.rps) || 0;
    return `
      <tr class="${cr ? "sfc-credited" : ""}" data-key="${key}">
        <td class="num">${esc(it.displayNumber)}</td>
        <td class="left desc">${esc(it.description)}</td>
        <td class="left qty">${esc(it.quantity)}</td>
        <td>${fmtUSD(Number(it.rcv) || 0)}</td>
        <td>${rec > 0 ? fmtUSD(rec) : dash}</td>
        <td>${nr > 0 ? fmtUSD(nr) : dash}</td>
        ${showRps ? `<td>${cp > 0 ? fmtUSD(cp) : dash}</td>` : ""}
        <td class="acv">${fmtUSD(sfcLineACV(it))}</td>
        <td class="check"><input class="sfc-credit" type="checkbox" data-key="${key}" ${cr ? "checked" : ""} title="Credit this line's ACV to the homeowner" /></td>
      </tr>`;
  };
  const c0 = sfcContracted(g);
  const toggle = `<div class="sfc-tradenav-toggles">
        <label class="sfc-toggle credit"><input type="checkbox" id="sfcAllCredit" ${g.items.length && c0.credited === g.items.length ? "checked" : ""} /> Credit entire trade</label>
      </div>`;
  document.getElementById("sfcBody").innerHTML = sfcNavHTML({
    step: `Trade ${idx + 1} of ${n}`, trade: g.trade, color: g.color, right: toggle, prevDisabled: idx === 0,
    nextLabel: idx + 1 < n ? "Next →" : "Assumptions →",
  }) + `
    <table class="sfc-lines">
      <thead><tr>
        <th class="num">Line #</th><th class="left">Description</th><th class="left">Quantity</th>
        <th>RCV</th><th>Recoverable Dep.</th><th>Non-Rec. Dep.</th>${showRps ? "<th>RPS Cust. Portion</th>" : ""}<th>ACV</th><th class="check">Credit ACV</th>
      </tr></thead>
      <tbody id="sfcTradeRows">${g.items.map(rowHTML).join("")}</tbody>
      <tfoot><tr>
        <td class="left" colspan="3">${esc(g.trade)} · ${g.items.length} line${g.items.length === 1 ? "" : "s"}</td>
        <td>${fmtUSD(g.rcv)}</td><td>${fmtUSD(g.recDep)}</td><td>${fmtUSD(g.nonRecDep)}</td>${showRps ? `<td>${fmtUSD(g.rps)}</td>` : ""}<td>${fmtUSD(g.acv)}</td>
        <td class="check credit-total" id="sfcTradeCredit">${fmtUSD(c0.credit)}</td>
      </tr></tfoot>
    </table>`;
  const byKey = new Map(g.items.map((it) => [String(sfcLineKey(it)), it]));
  const repaint = () => {
    document.getElementById("sfcTradeRows").innerHTML = g.items.map(rowHTML).join("");
    const c = sfcContracted(g);
    document.getElementById("sfcCreditsSoFar").textContent = fmtUSD(sfcTotalCredits());
    document.getElementById("sfcTradeCredit").textContent = fmtUSD(c.credit);
    document.getElementById("sfcAllCredit").checked = g.items.length > 0 && c.credited === g.items.length;
    wire();
  };
  const wire = () => {
    for (const box of document.querySelectorAll(".sfc-credit")) {
      box.addEventListener("change", () => { sfcSetCredited(byKey.get(box.dataset.key), box.checked); repaint(); });
    }
  };
  wire();
  document.getElementById("sfcAllCredit").addEventListener("change", (e) => {
    for (const it of g.items) sfcSetCredited(it, e.target.checked);
    repaint();
  });
  sfcWireNav();
}

// ---- step: assumptions — one page per trade we are contracting ----
// No rates are shown on any of them: the production manager states what the work IS; the
// price list prices it. Anything not on the list takes management's estimated cost and the
// walk cannot move on until it is typed.
function renderSfcAssumptions(g, pos, count) {
  const body = document.getElementById("sfcBody");
  if (!g) {
    body.innerHTML = sfcNavHTML({ step: "Assumptions", trade: "Nothing to price" }) +
      `<p class="sfc-note">Every trade on this claim is credited or claim-only — nothing to assume. Continue to pricing.</p>`;
    sfcWireNav();
    return;
  }
  const nav = sfcNavHTML({ step: `Assumptions ${pos} of ${count}`, trade: g.trade, color: g.color });
  if (g.trade === "GUTTERS") return renderGutterAssumptions(body, nav);
  if (g.trade === "SIDING") return renderSidingAssumptions(body, nav);
  if (g.trade !== "ROOF") return renderBidAssumptions(body, nav, g);
  // ROOF: type(s) › squares per type › pitch › redecking
  const r = sfc.roof;
  const L = priceList.ROOF;
  const needsBid = sfcRoofNeedsBid();
  const total = sfcRoofTotalSq();
  const pitchSum = Math.round(((Number(r.steepSq) || 0) + (Number(r.walkSq) || 0)) * 100) / 100;
  // The pitch split must account for every square — not fewer, not more — before moving on.
  const pitchOk = total > 0 && Math.abs(pitchSum - total) <= 0.01;
  const pitchNote = total <= 0
    ? `<span class="sfc-as-flag on">Enter the roof squares first</span>`
    : pitchOk
      ? `<span class="sfc-as-flag">Matches the roof total</span>`
      : `<span class="sfc-as-flag on">Pitch squares total ${esc(pitchSum)} SQ — they must equal the roof's ${esc(total)} SQ to continue</span>`;
  const used = new Set(r.types.map((t) => t.key));
  const bidMissing = sfcRoofBidMissing();
  const typeRows = r.types.map((t, i) => {
    const spec = roofTypeSpec(t.key);
    return `
      <tr data-i="${i}">
        <td class="trade"><span class="trade-cell">${esc(spec.label)}</span>${spec.bid ? `<span class="sfc-bid-tag">not on price list</span>` : ""}</td>
        <td class="num sqc"><span class="sfc-field"><input class="input sfc-rt-sq" type="number" min="0" step="0.01" inputmode="decimal" data-i="${i}"
            value="${t.sq != null ? esc(t.sq) : ""}" placeholder="0" /><span class="uom">SQ</span></span></td>
        ${needsBid ? `<td class="num bidc">${spec.bid ? `<span class="sfc-field"><span class="pl-cur">$</span><input class="input sfc-rt-bid${Number(t.bid) > 0 ? "" : " missing"}" type="number" min="0" step="1" inputmode="decimal" data-i="${i}"
            value="${t.bid != null ? esc(t.bid) : ""}" placeholder="0" title="Estimated cost from management" /></span>` : ""}</td>` : ""}
        <td class="check"><button type="button" class="btn btn-ghost btn-lock sfc-rt-del" data-i="${i}" title="Remove">✕</button></td>
      </tr>`;
  }).join("");
  const pick = `
      <select id="sfcRoofTypePick" class="input sfc-up-pick" aria-label="Add roof type">
        <option value="">＋ Add roof type…</option>
        ${ROOF_TYPES.filter((t) => !used.has(t.key)).map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join("")}
      </select>`;
  body.innerHTML = nav + `
    <ol class="sfc-flow">
      <li class="sfc-flow-step">
        <div class="sfc-flow-n">1</div>
        <div class="sfc-flow-body">
          <p class="sfc-flow-title">Roof type(s)</p>
          <p class="sfc-flow-hint">Select every roof type on the house — some roofs have more than one.</p>
          <div class="sfc-flow-chips">${r.types.map((t) => `<span class="sfc-chip${roofTypeSpec(t.key).bid ? " bid" : ""}">${esc(roofTypeSpec(t.key).label)}</span>`).join("")}</div>
          ${pick}
        </div>
      </li>
      <li class="sfc-flow-step${r.types.length ? "" : " off"}">
        <div class="sfc-flow-n">2</div>
        <div class="sfc-flow-body">
          <p class="sfc-flow-title">Squares per roof type</p>
          ${r.types.length ? `
          <table class="sfc-form sfc-rooftypes${needsBid ? " has-bid" : ""}">
            <thead><tr><th class="trade">Roof type</th><th class="num sqc">Squares</th>${needsBid ? `<th class="num bidc">Estimated cost</th>` : ""}<th class="check"></th></tr></thead>
            <tbody>${typeRows}</tbody>
          </table>
          <div class="sfc-as-total">Total roof <b>${esc(total)} SQ</b></div>` : `<p class="sfc-flow-hint">Add a roof type first.</p>`}
        </div>
      </li>
      <li class="sfc-flow-step">
        <div class="sfc-flow-n">3</div>
        <div class="sfc-flow-body">
          <p class="sfc-flow-title">Pitch</p>
          <p class="sfc-flow-hint">Pitch can change across a roof — split the squares.</p>
          <div class="sfc-flow-pair">
            <label class="sfc-flow-field"><span class="sfc-flow-k">${esc(L.steep.fromPitch)}/12 and steeper</span>
              <input id="sfcRoofSteepSq" class="input" type="number" min="0" step="0.01" inputmode="decimal" value="${r.steepSq != null ? esc(r.steepSq) : ""}" placeholder="0" /><span class="uom">SQ</span></label>
            <label class="sfc-flow-field"><span class="sfc-flow-k">Under ${esc(L.steep.fromPitch)}/12</span>
              <input id="sfcRoofWalkSq" class="input" type="number" min="0" step="0.01" inputmode="decimal" value="${r.walkSq != null ? esc(r.walkSq) : ""}" placeholder="0" /><span class="uom">SQ</span></label>
          </div>
          ${pitchNote}
        </div>
      </li>
      <li class="sfc-flow-step">
        <div class="sfc-flow-n">4</div>
        <div class="sfc-flow-body">
          <p class="sfc-flow-title">Redecking required?</p>
          <span class="sfc-field sfc-flow-field">
            <span class="sfc-mode" role="group" aria-label="Redecking required">
              <button type="button" class="sfc-mode-btn sfc-redeck-btn" data-v="1" aria-pressed="${!!r.redeck}">Yes</button>
              <button type="button" class="sfc-mode-btn sfc-redeck-btn" data-v="0" aria-pressed="${!r.redeck}">No</button>
            </span>
            ${r.redeck ? `<input id="sfcRoofRedeckSq" class="input" type="number" min="0" step="0.01" inputmode="decimal" value="${r.redeckSq != null ? esc(r.redeckSq) : ""}" placeholder="0" /><span class="uom">SQ</span>` : ""}
          </span>
        </div>
      </li>
      ${costItemsStepHTML("ROOF", 5)}
    </ol>
    ${needsBid ? `
    <div class="sfc-bid-banner">
      <b>${esc(r.types.filter((t) => roofTypeSpec(t.key).bid).map((t) => roofTypeSpec(t.key).label).join(" & ").toUpperCase())} NOT ON PRICE LIST CURRENTLY; ASK MANAGEMENT FOR ESTIMATED COSTS</b>
      <span>${bidMissing ? "Enter the estimated cost next to the roof type above to continue." : "Estimated cost entered — the roof prices with it."}</span>
    </div>` : ""}`;
  document.getElementById("sfcNextBtn").disabled = bidMissing || !pitchOk;
  document.getElementById("sfcNextBtn").title = bidMissing ? "Enter the estimated cost first" : !pitchOk ? "Pitch squares must equal the roof total" : "";

  const snapshot = () => {
    costItemsSnapshot("ROOF");
    for (const inp of document.querySelectorAll(".sfc-rt-sq")) { const t = r.types[Number(inp.dataset.i)]; if (t) { const v = Number(inp.value); t.sq = v > 0 ? v : null; } }
    for (const inp of document.querySelectorAll(".sfc-rt-bid")) { const t = r.types[Number(inp.dataset.i)]; if (t) { const v = Number(inp.value); t.bid = v > 0 ? v : null; } }
    const stEl = document.getElementById("sfcRoofSteepSq"); if (stEl) { const v = Number(stEl.value); r.steepSq = v > 0 ? v : null; }
    const wkEl = document.getElementById("sfcRoofWalkSq"); if (wkEl) { const v = Number(wkEl.value); r.walkSq = v > 0 ? v : null; }
    const rdSq = document.getElementById("sfcRoofRedeckSq"); if (rdSq) { const v = Number(rdSq.value); r.redeckSq = v > 0 ? v : null; }
    const sq = sfcRoofTotalSq();
    sfc.measurements.ROOF = sq > 0 ? sq : null; // the roof's quantity everywhere downstream
  };
  const rerender = () => { snapshot(); renderSfcAssumptions(); };
  document.getElementById("sfcRoofTypePick").addEventListener("change", (e) => {
    const key = e.target.value; if (!key) return;
    snapshot(); r.types.push({ key, sq: null, bid: null }); renderSfcAssumptions();
    const last = document.querySelector(".sfc-rooftypes tbody tr:last-child .sfc-rt-sq"); if (last) last.focus();
  });
  for (const el of document.querySelectorAll(".sfc-rt-sq, .sfc-rt-bid, .sfc-ci-qty, #sfcRoofSteepSq, #sfcRoofWalkSq, #sfcRoofRedeckSq")) el.addEventListener("change", rerender);
  for (const btn of document.querySelectorAll(".sfc-rt-del")) btn.addEventListener("click", () => { snapshot(); r.types.splice(Number(btn.dataset.i), 1); renderSfcAssumptions(); });
  for (const btn of document.querySelectorAll(".sfc-redeck-btn")) btn.addEventListener("click", () => {
    snapshot(); r.redeck = btn.dataset.v === "1"; if (!r.redeck) r.redeckSq = null; renderSfcAssumptions();
    const sqEl = document.getElementById("sfcRoofRedeckSq"); if (sqEl) sqEl.focus();
  });
  sfcWireNav(snapshot, snapshot);
}

// ---- owner-added cost items: one quantity box per item, on every trade's Assumptions page ----
function costItemsStepHTML(trade, n) {
  const items = sfcCostItems(trade);
  if (!items.length) return "";
  const q = sfc.costQty[trade] || {};
  return `
      <li class="sfc-flow-step"><div class="sfc-flow-n">${n}</div><div class="sfc-flow-body">
        <p class="sfc-flow-title">Add-on costs</p>
        <p class="sfc-flow-hint">Quantity of each that applies — leave the rest at 0.</p>
        <table class="sfc-form sfc-rooftypes">
          <thead><tr><th class="trade">Item</th><th class="num sqc">Quantity</th><th class="check"></th></tr></thead>
          <tbody>${items.map((it) => `
            <tr><td class="trade"><span class="trade-cell">${esc(it.label)}</span></td>
              <td class="num sqc"><span class="sfc-field"><input class="input sfc-ci-qty" type="number" min="0" step="0.01" inputmode="decimal" data-t="${esc(trade)}" data-k="${esc(it.key)}"
                value="${q[it.key] != null ? esc(q[it.key]) : ""}" placeholder="0" /><span class="uom">${esc(it.unit)}</span></span></td>
              <td class="check"></td></tr>`).join("")}</tbody>
        </table>
      </div></li>`;
}
function costItemsSnapshot(trade) {
  const q = sfc.costQty[trade] || (sfc.costQty[trade] = {});
  for (const inp of document.querySelectorAll(`.sfc-ci-qty[data-t="${trade}"]`)) { const v = Number(inp.value); q[inp.dataset.k] = v > 0 ? v : null; }
}

// ---- gutters: type › LF › size › paint. Super simple. ----
function renderGutterAssumptions(body, nav) {
  const g = sfc.gutters;
  const L = priceList.GUTTERS;
  const lf = Math.round(((Number(g.gutterLf) || 0) + (Number(g.downLf) || 0)) * 100) / 100;
  const ready = !!sfcGutterCost();
  const seg = (cls, opts, cur) => `<span class="sfc-mode" role="group">${opts.map(([v, label]) =>
    `<button type="button" class="sfc-mode-btn ${cls}" data-v="${esc(v)}" aria-pressed="${cur === v}">${esc(label)}</button>`).join("")}</span>`;
  const missing = [];
  if (!g.type) missing.push("gutter type");
  if (!(lf > 0)) missing.push("linear feet");
  if (!g.size) missing.push("size");
  if (g.paint == null) missing.push("paint");
  body.innerHTML = nav + `
    <ol class="sfc-flow">
      <li class="sfc-flow-step"><div class="sfc-flow-n">1</div><div class="sfc-flow-body">
        <p class="sfc-flow-title">Gutter type</p>
        <span class="sfc-field sfc-flow-field">${seg("sfc-gt-type", L.types.map((t) => [t.key, t.label]), g.type)}</span>
      </div></li>
      <li class="sfc-flow-step"><div class="sfc-flow-n">2</div><div class="sfc-flow-body">
        <p class="sfc-flow-title">Linear feet</p>
        <p class="sfc-flow-hint">Gutters and downspouts separately.</p>
        <div class="sfc-flow-pair">
          <label class="sfc-flow-field"><span class="sfc-flow-k">Gutters</span><input id="sfcGtLf" class="input" type="number" min="0" step="0.01" inputmode="decimal" value="${g.gutterLf != null ? esc(g.gutterLf) : ""}" placeholder="0" /><span class="uom">LF</span></label>
          <label class="sfc-flow-field"><span class="sfc-flow-k">Downspouts</span><input id="sfcGtDown" class="input" type="number" min="0" step="0.01" inputmode="decimal" value="${g.downLf != null ? esc(g.downLf) : ""}" placeholder="0" /><span class="uom">LF</span></label>
        </div>
        <div class="sfc-as-total">Total <b>${esc(lf)} LF</b></div>
      </div></li>
      <li class="sfc-flow-step"><div class="sfc-flow-n">3</div><div class="sfc-flow-body">
        <p class="sfc-flow-title">Gutter size</p>
        <span class="sfc-field sfc-flow-field">${seg("sfc-gt-size", [["5", '5 inch'], ["6", '6 inch']], g.size)}</span>
      </div></li>
      <li class="sfc-flow-step"><div class="sfc-flow-n">4</div><div class="sfc-flow-body">
        <p class="sfc-flow-title">Paint needed?</p>
        <span class="sfc-field sfc-flow-field">${seg("sfc-gt-paint", [["1", "Yes"], ["0", "No"]], g.paint == null ? null : g.paint ? "1" : "0")}</span>
      </div></li>
      ${costItemsStepHTML("GUTTERS", 5)}
    </ol>
    ${ready ? "" : `<p class="sfc-as-flag on sfc-flow-gate">Select ${esc(missing.join(", "))} to continue.</p>`}`;
  document.getElementById("sfcNextBtn").disabled = !ready;
  const snapshot = () => {
    costItemsSnapshot("GUTTERS");
    const a = document.getElementById("sfcGtLf"), b = document.getElementById("sfcGtDown");
    g.gutterLf = Number(a.value) > 0 ? Number(a.value) : null;
    g.downLf = Number(b.value) > 0 ? Number(b.value) : null;
    const c = sfcGutterCost();
    sfc.measurements.GUTTERS = c ? c.qty : (Math.round(((g.gutterLf || 0) + (g.downLf || 0)) * 100) / 100 || null);
  };
  const rerender = () => { snapshot(); renderGutterAssumptions(body, nav); };
  for (const el of document.querySelectorAll("#sfcGtLf, #sfcGtDown, .sfc-ci-qty")) el.addEventListener("change", rerender);
  for (const btn of document.querySelectorAll(".sfc-gt-type")) btn.addEventListener("click", () => { snapshot(); g.type = btn.dataset.v; renderGutterAssumptions(body, nav); });
  for (const btn of document.querySelectorAll(".sfc-gt-size")) btn.addEventListener("click", () => { snapshot(); g.size = btn.dataset.v; renderGutterAssumptions(body, nav); });
  for (const btn of document.querySelectorAll(".sfc-gt-paint")) btn.addEventListener("click", () => { snapshot(); g.paint = btn.dataset.v === "1"; renderGutterAssumptions(body, nav); });
  sfcWireNav(snapshot, snapshot);
}

// ---- siding: type(s) › SF per type; types off the list take management's estimated cost ----
function renderSidingAssumptions(body, nav) {
  const sd = sfc.siding;
  const L = priceList.SIDING;
  const needsBid = sfcSidingNeedsBid();
  const bidMissing = sfcSidingBidMissing();
  const total = sfcSidingTotalSf();
  const used = new Set(sd.types.map((t) => t.key));
  const ready = total > 0 && !bidMissing;
  const typeRows = sd.types.map((t, i) => {
    const spec = sidingTypeSpec(t.key);
    return `
      <tr data-i="${i}">
        <td class="trade"><span class="trade-cell">${esc(spec.label)}</span>${spec.bid ? `<span class="sfc-bid-tag">not on price list</span>` : ""}</td>
        <td class="num sqc"><span class="sfc-field"><input class="input sfc-sd-sf" type="number" min="0" step="0.01" inputmode="decimal" data-i="${i}"
            value="${t.sf != null ? esc(t.sf) : ""}" placeholder="0" /><span class="uom">SF</span></span></td>
        ${needsBid ? `<td class="num bidc">${spec.bid ? `<span class="sfc-field"><span class="pl-cur">$</span><input class="input sfc-sd-bid${Number(t.bid) > 0 ? "" : " missing"}" type="number" min="0" step="1" inputmode="decimal" data-i="${i}"
            value="${t.bid != null ? esc(t.bid) : ""}" placeholder="0" title="Estimated cost from management" /></span>` : ""}</td>` : ""}
        <td class="check"><button type="button" class="btn btn-ghost btn-lock sfc-sd-del" data-i="${i}" title="Remove">✕</button></td>
      </tr>`;
  }).join("");
  const listed = L.types.filter((t) => !t.bid && !used.has(t.key)), bids = L.types.filter((t) => t.bid && !used.has(t.key));
  const pick = `
      <select id="sfcSidingTypePick" class="input sfc-up-pick" aria-label="Add siding type">
        <option value="">＋ Add siding type…</option>
        ${listed.map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join("")}
        ${bids.length ? `<optgroup label="Requires bid">${bids.map((t) => `<option value="${esc(t.key)}">${esc(t.label)} — requires bid</option>`).join("")}</optgroup>` : ""}
      </select>`;
  body.innerHTML = nav + `
    <ol class="sfc-flow">
      <li class="sfc-flow-step"><div class="sfc-flow-n">1</div><div class="sfc-flow-body">
        <p class="sfc-flow-title">Type of siding</p>
        <p class="sfc-flow-hint">Select every siding type on the house — more than one is unusual, but it happens.</p>
        <div class="sfc-flow-chips">${sd.types.map((t) => `<span class="sfc-chip${sidingTypeSpec(t.key).bid ? " bid" : ""}">${esc(sidingTypeSpec(t.key).label)}</span>`).join("")}</div>
        ${pick}
      </div></li>
      <li class="sfc-flow-step${sd.types.length ? "" : " off"}"><div class="sfc-flow-n">2</div><div class="sfc-flow-body">
        <p class="sfc-flow-title">Square feet per siding type</p>
        ${sd.types.length ? `
        <table class="sfc-form sfc-rooftypes${needsBid ? " has-bid" : ""}">
          <thead><tr><th class="trade">Siding type</th><th class="num sqc">Square feet</th>${needsBid ? `<th class="num bidc">Estimated cost</th>` : ""}<th class="check"></th></tr></thead>
          <tbody>${typeRows}</tbody>
        </table>
        <div class="sfc-as-total">Total siding <b>${esc(total)} SF</b></div>` : `<p class="sfc-flow-hint">Add a siding type first.</p>`}
      </div></li>
      ${costItemsStepHTML("SIDING", 3)}
    </ol>
    ${needsBid ? `
    <div class="sfc-bid-banner">
      <b>${esc(sd.types.filter((t) => sidingTypeSpec(t.key).bid).map((t) => sidingTypeSpec(t.key).label).join(" & ").toUpperCase())} NOT ON PRICE LIST CURRENTLY; ASK MANAGEMENT FOR ESTIMATED COSTS</b>
      <span>${bidMissing ? "Enter the estimated cost next to the siding type above to continue." : "Estimated cost entered — the siding prices with it."}</span>
    </div>` : ""}
    ${!ready && !bidMissing ? `<p class="sfc-as-flag on sfc-flow-gate">Enter the square feet to continue.</p>` : ""}`;
  document.getElementById("sfcNextBtn").disabled = !ready;
  const snapshot = () => {
    costItemsSnapshot("SIDING");
    for (const inp of document.querySelectorAll(".sfc-sd-sf")) { const t = sd.types[Number(inp.dataset.i)]; if (t) { const v = Number(inp.value); t.sf = v > 0 ? v : null; } }
    for (const inp of document.querySelectorAll(".sfc-sd-bid")) { const t = sd.types[Number(inp.dataset.i)]; if (t) { const v = Number(inp.value); t.bid = v > 0 ? v : null; } }
    const sf = sfcSidingTotalSf();
    sfc.measurements.SIDING = sf > 0 ? sf : null;
  };
  const rerender = () => { snapshot(); renderSidingAssumptions(body, nav); };
  document.getElementById("sfcSidingTypePick").addEventListener("change", (e) => {
    const key = e.target.value; if (!key) return;
    snapshot(); sd.types.push({ key, sf: null, bid: null }); renderSidingAssumptions(body, nav);
    const last = document.querySelector(".sfc-rooftypes tbody tr:last-child .sfc-sd-sf"); if (last) last.focus();
  });
  for (const el of document.querySelectorAll(".sfc-sd-sf, .sfc-sd-bid, .sfc-ci-qty")) el.addEventListener("change", rerender);
  for (const btn of document.querySelectorAll(".sfc-sd-del")) btn.addEventListener("click", () => { snapshot(); sd.types.splice(Number(btn.dataset.i), 1); renderSidingAssumptions(body, nav); });
  sfcWireNav(snapshot, snapshot);
}

// ---- every other trade: bid pricing only — quantity + management's estimated cost ----
function renderBidAssumptions(body, nav, g) {
  const t = g.trade;
  const uom = SFC_TRADE_UOM[t] || "EA";
  const items = sfcCostItems(t);
  const bid = sfc.bids[t], qty = sfc.measurements[t];
  const priced = sfcCostItemParts(t).length > 0;
  const ready = items.length ? priced || Number(bid) > 0 : Number(bid) > 0;
  let n = 0;
  body.innerHTML = nav + `
    <ol class="sfc-flow">
      ${items.length ? costItemsStepHTML(t, ++n).replace("Add-on costs", "What applies") : ""}
      <li class="sfc-flow-step"><div class="sfc-flow-n">${++n}</div><div class="sfc-flow-body">
        <p class="sfc-flow-title">Quantity</p>
        <span class="sfc-field sfc-flow-field"><input id="sfcBidQty" class="input" type="number" min="0" step="0.01" inputmode="decimal" value="${qty != null ? esc(qty) : ""}" placeholder="0" /><span class="uom">${esc(uom)}</span></span>
      </div></li>
      <li class="sfc-flow-step"><div class="sfc-flow-n">${++n}</div><div class="sfc-flow-body">
        <p class="sfc-flow-title">${items.length ? "Anything not listed above — estimated cost" : "Estimated cost"}</p>
        <span class="sfc-field sfc-flow-field"><span class="pl-cur">$</span><input id="sfcBidCost" class="input sfc-rt-bid${ready ? "" : " missing"}" type="number" min="0" step="1" inputmode="decimal" value="${bid != null ? esc(bid) : ""}" placeholder="0" /></span>
      </div></li>
    </ol>
    ${items.length ? (ready ? "" : `<p class="sfc-as-flag on sfc-flow-gate">Enter a quantity above, or an estimated cost, to continue.</p>`) : `
    <div class="sfc-bid-banner">
      <b>${esc(t)} IS BID PRICING ONLY; ASK MANAGEMENT FOR ESTIMATED COSTS</b>
      <span>${ready ? "Estimated cost entered — this trade prices with it." : "Enter the estimated cost above to continue."}</span>
    </div>`}`;
  document.getElementById("sfcNextBtn").disabled = !ready;
  const snapshot = () => {
    costItemsSnapshot(t);
    const q = Number(document.getElementById("sfcBidQty").value), b = Number(document.getElementById("sfcBidCost").value);
    sfc.measurements[t] = q > 0 ? q : null;
    sfc.bids[t] = b > 0 ? b : null;
  };
  const rerender = () => { snapshot(); renderBidAssumptions(body, nav, g); };
  for (const el of document.querySelectorAll("#sfcBidQty, #sfcBidCost, .sfc-ci-qty")) el.addEventListener("change", rerender);
  sfcWireNav(snapshot, snapshot);
}

function renderSfcPricing() {
  const groups = sfcJobTrades();
  const rows = groups
    .map((g) => {
      const c = sfcContracted(g);
      const ups = sfcUpgradesFor(g.trade);
      const uom = SFC_TRADE_UOM[g.trade];
      const note =
        (c.credited ? `<span class="sfc-credited-note">${c.credited} line${c.credited === 1 ? "" : "s"} credited</span>` : "") +
        (ups.length ? `<span class="sfc-upgrade-note">${ups.length} upgrade${ups.length === 1 ? "" : "s"} +${fmtUSD(ups.reduce((a, u) => a + (Number(u.price) || 0), 0))}</span>` : "");
      const supp = sfcSuppStatus(g.trade, c);
      const suppCell = `<td class="supp"><select class="input sfc-supp" data-trade="${esc(g.trade)}" aria-label="Supplement status">${SFC_SUPP_OPTIONS.map((o) => `<option value="${esc(o)}" ${o === supp ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></td>`;
      const tradeCell = `<td class="trade"><span class="trade-cell"><span class="trade-swatch" style="background:${g.color}"></span>${esc(g.trade)}</span>${note}</td>`;
      if (c.rcv <= 0) {
        return `
      <tr class="sfc-claimonly">${suppCell}${tradeCell}<td class="num rcv">${fmtUSD(0)}</td><td class="num meas"></td>
        <td class="cost"><span class="sfc-rate"><em>${ups.length ? "upgrades only" : "credited"}</em></span></td></tr>`;
      }
      if (sfcIsClaimOnly(g.trade)) {
        return `
      <tr class="sfc-claimonly">${suppCell}${tradeCell}<td class="num rcv">${fmtUSD(c.rcv)}</td><td class="num meas"></td>
        <td class="cost"><span class="sfc-rate"><em>claim only</em></span></td></tr>`;
      }
      // It is just the cost: the trade's Assumptions step plus its upgrades' SFC cost.
      const tc = sfcTradeCost(g.trade);
      const upCost = ups.reduce((a, u) => a + (Number(u.cost) || 0), 0);
      return `
      <tr>${suppCell}${tradeCell}
        <td class="num rcv">${fmtUSD(c.rcv)}</td>
        <td class="num meas"><span class="sfc-field"><span class="sfc-rate">${tc && tc.qty > 0 ? `<b>${esc(tc.qty)}</b>` : "<em>—</em>"}</span><span class="uom">${esc(uom)}</span></span></td>
        <td class="cost">${tc
          ? `<span class="sfc-field"><span class="sfc-rate"><b>${fmtUSD(tc.cost + upCost)}</b></span></span>${upCost > 0 ? `<span class="sfc-cost-note">incl. upgrades +${fmtUSD(upCost)}</span>` : ""}`
          : `<span class="sfc-field"><span class="sfc-rate"><em>not priced — see Assumptions</em></span></span>`}</td>
      </tr>`;
    })
    .join("");

  const tradeOptions = (sel) =>
    [...new Set([...TRADE_ORDER, ...groups.map((g) => g.trade)])]
      .map((t) => `<option value="${esc(t)}" ${t === sel ? "selected" : ""}>${esc(t)}</option>`).join("");
  const upgradeRows = sfc.upgrades.map((u) => {
    const spec = sfcUpgradeSpec(u);
    if (spec) {
      const ru = sfcResolveUpgrade(u);
      const costCell = spec.costIn
        ? `<span class="sfc-muted" title="SFC cost is already in the ${esc(spec.costIn)} assumption">in ${esc(spec.costIn)}</span>`
        : sfcUpgradeUnitCost(spec) > 0
          ? fmtUSD(ru.cost)
          : `<span class="sfc-warn" title="Set this upgrade's SFC cost in the price list">no SFC cost set</span>`;
      return `
      <tr data-id="${u.id}" class="sfc-up-list">
        <td class="trade"><span class="trade-cell"><span class="trade-swatch" style="background:${TRADE_COLORS[u.trade] || "#94a3b8"}"></span>${esc(u.trade)}</span></td>
        <td><b>${esc(spec.label)}</b></td>
        <td class="num uq"><span class="sfc-field"><input class="input sfc-up-qty" type="number" min="0" step="0.01" inputmode="decimal" data-id="${u.id}"
            value="${u.qty != null ? esc(u.qty) : ""}" placeholder="0" /><span class="uom">${esc(spec.unit)}</span></span></td>
        <td class="num sfc-up-calc">${fmtUSD(ru.price)}</td>
        <td class="num sfc-up-calc">${costCell}</td>
        <td class="check"><button type="button" class="btn btn-ghost btn-lock sfc-up-del" data-id="${u.id}" title="Remove">✕</button></td>
      </tr>`;
    }
    return `
      <tr data-id="${u.id}">
        <td class="trade"><select class="input sfc-up-trade" data-id="${u.id}">${tradeOptions(u.trade)}</select></td>
        <td><input class="input input-wide sfc-up-desc" type="text" data-id="${u.id}" value="${esc(u.description || "")}" placeholder="Custom upgrade" /></td>
        <td class="num uq"></td>
        <td class="num"><input class="input sfc-up-price" type="number" min="0" step="1" inputmode="decimal" data-id="${u.id}" value="${u.price ? esc(u.price) : ""}" placeholder="$ price" /></td>
        <td class="num"><input class="input sfc-up-cost" type="number" min="0" step="1" inputmode="decimal" data-id="${u.id}" value="${u.cost ? esc(u.cost) : ""}" placeholder="$ SFC cost" /></td>
        <td class="check"><button type="button" class="btn btn-ghost btn-lock sfc-up-del" data-id="${u.id}" title="Remove">✕</button></td>
      </tr>`;
  }).join("");
  const upgradePick = `
      <select id="sfcUpgradePick" class="input sfc-up-pick" aria-label="Add upgrade">
        <option value="">＋ Add upgrade…</option>
        ${PRICEABLE_TRADES.filter((t) => priceList[t] && priceList[t].upgrades.length).map((t) => `<optgroup label="${esc(t)} upgrades">${priceList[t].upgrades.map((u) => `<option value="${esc(t)}:${esc(u.key)}">${esc(u.label)}</option>`).join("")}</optgroup>`).join("")}
        <option value="custom">Custom upgrade — type the price</option>
      </select>`;
  const marketingRows = sfc.marketingCredits.map((m) => `
      <tr data-id="${m.id}">
        <td><select class="input sfc-mk-type" data-id="${m.id}">${SFC_MARKETING_TYPES.map((t) => `<option value="${esc(t)}" ${t === m.type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></td>
        <td class="num"><input class="input sfc-mk-amount" type="number" min="0" step="1" inputmode="decimal" data-id="${m.id}" value="${m.amount ? esc(m.amount) : ""}" placeholder="$" /></td>
        <td class="check"><button type="button" class="btn btn-ghost btn-lock sfc-mk-del" data-id="${m.id}" title="Remove">✕</button></td>
      </tr>`).join("");

  document.getElementById("sfcBody").innerHTML = sfcNavHTML({ step: "Pricing", trade: "Measurements, upgrades, credits", nextLabel: "Build estimate →" }) + `
    <div class="sfc-controls">
      <label>Client <input id="sfcClient" class="input input-wide" type="text" value="${esc(sfc.client)}" placeholder="Homeowner" /></label>
      <label>Deductible <span class="sfc-field"><input id="sfcDeductible" class="input" type="number" min="0" step="0.01" inputmode="decimal"
             value="${sfc.deductible != null ? esc(sfc.deductible) : ""}" placeholder="$" title="From the claim when stated; type it when the appraisal leaves it off" /></span></label>
    </div>
    <table class="sfc-form">
      <thead><tr><th class="supp">Supp status</th><th class="trade">Trade</th><th class="num rcv">Contracted RCV</th><th class="num meas">Measurement</th><th class="cost">SFC cost</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="section-label sfc-upgrades-label">Upgrades &amp; add-ons <span class="sfc-muted">roof upgrades are priced for you — type the quantity; custom upgrades take a typed price</span></p>
    <table class="sfc-form sfc-upgrades sfc-upgrades-6">
      <thead><tr><th class="trade">Trade</th><th>Upgrade</th><th class="num uq">Qty</th><th class="num up">Price</th><th class="num uc">SFC cost</th><th class="check"></th></tr></thead>
      <tbody id="sfcUpgradeRows">${upgradeRows}</tbody>
    </table>
    <div class="sfc-upgrade-foot">${upgradePick}</div>
    <p class="section-label sfc-upgrades-label">Marketing credits <span class="sfc-muted">come off the homeowner's price</span></p>
    <table class="sfc-form sfc-upgrades sfc-marketing">
      <thead><tr><th class="trade">Credit</th><th class="num">Amount</th><th class="check"></th></tr></thead>
      <tbody id="sfcMarketingRows">${marketingRows}</tbody>
    </table>
    <div class="sfc-upgrade-foot"><button type="button" id="sfcAddMarketing" class="btn btn-ghost">＋ Add marketing credit</button></div>`;

  const snapshot = () => {
    for (const sel of document.querySelectorAll(".sfc-supp")) sfc.supp[sel.dataset.trade] = sel.value;
    for (const u of sfc.upgrades) {
      const q = (cls) => document.querySelector(`.${cls}[data-id="${u.id}"]`);
      if (q("sfc-up-qty")) { const v = q("sfc-up-qty").value; u.qty = v === "" ? null : Math.max(0, Number(v) || 0); }
      if (q("sfc-up-trade")) u.trade = q("sfc-up-trade").value;
      if (q("sfc-up-desc")) u.description = q("sfc-up-desc").value.trim();
      if (q("sfc-up-price")) u.price = Math.max(0, Number(q("sfc-up-price").value) || 0);
      if (q("sfc-up-cost")) u.cost = Math.max(0, Number(q("sfc-up-cost").value) || 0);
    }
    for (const m of sfc.marketingCredits) {
      const q = (cls) => document.querySelector(`.${cls}[data-id="${m.id}"]`);
      if (q("sfc-mk-type")) m.type = q("sfc-mk-type").value;
      if (q("sfc-mk-amount")) m.amount = Math.max(0, Number(q("sfc-mk-amount").value) || 0);
    }
    sfc.client = document.getElementById("sfcClient").value.trim();
    const d = document.getElementById("sfcDeductible").value;
    sfc.deductible = d === "" ? null : Math.max(0, Number(d) || 0);
    if (state.summary) { state.summary.deductible = sfc.deductible; syncDeductibleUI(); }
  };
  const rerender = () => { snapshot(); renderSfcPricing(); };
  for (const el of document.querySelectorAll(".sfc-up-qty")) el.addEventListener("change", rerender);
  document.getElementById("sfcUpgradePick").addEventListener("change", (e) => {
    const v = e.target.value; if (!v) return;
    snapshot();
    if (v === "custom") {
      sfc.upgrades.push({ id: sfcSeq++, trade: groups[0] ? groups[0].trade : TRADE_ORDER[0], description: "", price: 0, cost: 0 });
      renderSfcPricing();
      const last = document.querySelector("#sfcUpgradeRows tr:last-child .sfc-up-desc"); if (last) last.focus();
    } else {
      const [trade, key] = v.split(":");
      sfc.upgrades.push({ id: sfcSeq++, trade, key, qty: null, description: "", price: 0, cost: 0 });
      renderSfcPricing();
      const last = document.querySelector("#sfcUpgradeRows tr:last-child .sfc-up-qty"); if (last) last.focus();
    }
  });
  for (const btn of document.querySelectorAll(".sfc-up-del")) btn.addEventListener("click", () => { snapshot(); sfc.upgrades = sfc.upgrades.filter((u) => String(u.id) !== btn.dataset.id); renderSfcPricing(); });
  for (const sel of document.querySelectorAll(".sfc-up-trade")) sel.addEventListener("change", rerender);
  for (const inp of document.querySelectorAll(".sfc-up-price")) inp.addEventListener("change", rerender);
  document.getElementById("sfcAddMarketing").addEventListener("click", () => {
    snapshot();
    sfc.marketingCredits.push({ id: sfcSeq++, type: SFC_MARKETING_TYPES[0], amount: 0 });
    renderSfcPricing();
    const last = document.querySelector("#sfcMarketingRows tr:last-child .sfc-mk-amount"); if (last) last.focus();
  });
  for (const btn of document.querySelectorAll(".sfc-mk-del")) btn.addEventListener("click", () => { snapshot(); sfc.marketingCredits = sfc.marketingCredits.filter((m) => String(m.id) !== btn.dataset.id); renderSfcPricing(); });
  const finish = () => {
    snapshot();
    sfc.upgrades = sfc.upgrades.filter((u) => u.key || u.price > 0 || u.description);
    sfc.marketingCredits = sfc.marketingCredits.filter((m) => m.amount > 0);
  };
  sfcWireNav(finish, finish);
}

// ---- price list page: owner-only. Not linked from the tool — it opens only when the URL
// ends in /pricelist (Netlify rewrite) or carries ?pricelist / #pricelist (local server). ----
const priceListRequested = () => /\/pricelist\/?$/i.test(location.pathname) || /(^|[?&#])pricelist(?![\w-])/i.test(location.search + location.hash);
const PL_UNITS = ["SQ", "SF", "LF", "EA", "PNL"];
let plDraft = null; // working copy while the page is open
let plSeq = 1;
let plTrade = "ROOF"; // the trade page showing
function openPriceList() {
  plDraft = JSON.parse(JSON.stringify(priceList));
  document.body.classList.add("pl-mode");
  document.getElementById("priceListPage").hidden = false;
  renderPriceListPage("");
}
function renderPriceListPage(status) {
  const L = plDraft;
  const row = (label, cells) => `<tr><td class="pl-k">${label}</td>${cells}</tr>`;
  const inp = (cls, key, v, unit, step = 1) => `<td class="pl-v"><span class="sfc-field"><span class="pl-cur">$</span><input class="input ${cls}" type="number" min="0" step="${step}" inputmode="decimal" data-key="${esc(key)}" value="${esc(v)}" /><span class="uom">/ ${esc(unit)}</span></span></td>`;
  const upgradesTable = (t) => {
    const ups = L[t].upgrades;
    const rows = ups.map((u) => {
      const costCell = u.classKey
        ? `<td class="pl-v"><span class="sfc-muted">${fmtRate(sfcUpgradeUnitCost(u))} / ${esc(u.unit)} <em>(class cost − base)</em></span></td>`
        : u.costIn
          ? `<td class="pl-v"><span class="sfc-muted">in ${esc(u.costIn)}</span></td>`
          : `<td class="pl-v"><span class="sfc-field"><span class="pl-cur">$</span><input class="input pl-up-cost" type="number" min="0" step="0.01" inputmode="decimal" data-t="${esc(t)}" data-k="${esc(u.key)}" value="${esc(u.cost)}" /><span class="uom">/ ${esc(u.unit)}</span></span></td>`;
      return `
      <tr>
        <td class="pl-k"><input class="input pl-up-label" type="text" data-t="${esc(t)}" data-k="${esc(u.key)}" value="${esc(u.label)}" placeholder="Upgrade name" /></td>
        <td class="pl-v"><select class="input pl-up-unit" data-t="${esc(t)}" data-k="${esc(u.key)}" ${u.classKey || u.costIn ? "disabled" : ""}>${PL_UNITS.map((x) => `<option value="${x}" ${x === u.unit ? "selected" : ""}>${x}</option>`).join("")}</select></td>
        <td class="pl-v"><span class="sfc-field"><span class="pl-cur">$</span><input class="input pl-up-price" type="number" min="0" step="0.01" inputmode="decimal" data-t="${esc(t)}" data-k="${esc(u.key)}" value="${esc(u.price)}" /><span class="uom">/ ${esc(u.unit)}</span></span></td>
        ${costCell}
        <td class="check"><button type="button" class="btn btn-ghost btn-lock pl-up-del" data-t="${esc(t)}" data-k="${esc(u.key)}" title="Remove from the list">✕</button></td>
      </tr>`;
    }).join("");
    return `
    <p class="section-label">Upgrades &amp; add-ons <span class="sfc-muted">what the homeowner is charged · what it costs SFC — these show in "Add upgrade…" on Pricing</span></p>
    <table class="disc-table pl-table pl-ups">
      <thead><tr><th>Name</th><th>Unit</th><th>Price charged</th><th>SFC cost</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td class="pl-k sfc-muted" colspan="5">No upgrades on this trade yet.</td></tr>`}</tbody>
    </table>
    <button type="button" class="btn btn-ghost pl-up-add" data-t="${esc(t)}">＋ Add an upgrade to ${esc(t)}</button>`;
  };
  const costsTable = (t) => {
    const items = L[t].costs;
    const rows = items.map((c) => `
      <tr>
        <td class="pl-k"><input class="input pl-ci-label" type="text" data-t="${esc(t)}" data-k="${esc(c.key)}" value="${esc(c.label)}" placeholder="Cost item name" /></td>
        <td class="pl-v"><select class="input pl-ci-unit" data-t="${esc(t)}" data-k="${esc(c.key)}">${PL_UNITS.map((x) => `<option value="${x}" ${x === c.unit ? "selected" : ""}>${x}</option>`).join("")}</select></td>
        <td class="pl-v"><span class="sfc-field"><span class="pl-cur">$</span><input class="input pl-ci-cost" type="number" min="0" step="0.01" inputmode="decimal" data-t="${esc(t)}" data-k="${esc(c.key)}" value="${esc(c.cost)}" /><span class="uom">/ ${esc(c.unit)}</span></span></td>
        <td class="check"><button type="button" class="btn btn-ghost btn-lock pl-ci-del" data-t="${esc(t)}" data-k="${esc(c.key)}" title="Remove">✕</button></td>
      </tr>`).join("");
    return `
    <p class="section-label">Cost items <span class="sfc-muted">what SFC pays per unit — each one gets a quantity box on this trade's Assumptions page and adds to its cost</span></p>
    <table class="disc-table pl-table pl-ups">
      <thead><tr><th>Name</th><th>Unit</th><th>SFC cost</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td class="pl-k sfc-muted" colspan="4">No cost items on this trade yet.</td></tr>`}</tbody>
    </table>
    <button type="button" class="btn btn-ghost pl-ci-add" data-t="${esc(t)}">＋ Add a cost item to ${esc(t)}</button>`;
  };
  const tabs = `<nav class="pl-tabs" aria-label="Trades">${PRICEABLE_TRADES.map((t) =>
    `<button type="button" class="pl-tab${t === plTrade ? " current" : ""}" data-t="${esc(t)}"><span class="trade-swatch" style="background:${TRADE_COLORS[t] || "#94a3b8"}"></span>${esc(t)}</button>`).join("")}</nav>`;
  const card = (t, inner) => `
    <section class="pl-trade">
      <h2><span class="trade-swatch" style="background:${TRADE_COLORS[t] || "#94a3b8"}"></span>${esc(t)} <span class="sfc-muted">per ${esc(SFC_TRADE_UOM[t])}</span></h2>
      ${inner}
      ${costsTable(t)}
      ${upgradesTable(t)}
    </section>`;
  const roof = `
    <p class="section-label">SFC cost <span class="sfc-muted">shingle roofs are assumed the base class; a class upgrade adds that class's cost difference</span></p>
    <table class="disc-table pl-table"><tbody>
      ${L.ROOF.shingles.map((sh) => row(esc(sh.label), inp("pl-shingle", sh.key, sh.cost, "SQ"))).join("")}
      ${row(`Steep slope — squares at <input class="input pl-pitch" type="number" min="1" step="1" value="${esc(L.ROOF.steep.fromPitch)}" aria-label="Steep from pitch" />/12 and steeper`, inp("pl-steep", "cost", L.ROOF.steep.cost, "SQ"))}
      ${row("Redecking", inp("pl-redeck", "cost", L.ROOF.redecking.cost, "SQ"))}
    </tbody></table>`;
  const gutters = `
    <p class="section-label">SFC cost <span class="sfc-muted">per LF of gutter + downspout</span></p>
    <table class="disc-table pl-table"><tbody>
      ${L.GUTTERS.types.map((t) => row(`${esc(t.label)} (base)`, inp("pl-gt-type", t.key, t.cost, "LF", 0.01))).join("")}
      ${row("6 inch adder", inp("pl-gt-six", "cost", L.GUTTERS.sixInch.cost, "LF", 0.01))}
      ${row("Painting adder", inp("pl-gt-paint", "cost", L.GUTTERS.paint.cost, "LF", 0.01))}
    </tbody></table>`;
  const siding = `
    <p class="section-label">SFC cost <span class="sfc-muted">per SF; every other type takes management's estimate on the Assumptions page</span></p>
    <table class="disc-table pl-table"><tbody>
      ${L.SIDING.types.map((t) => row(esc(t.label), t.bid ? `<td class="pl-v"><span class="sfc-muted">requires bid</span></td>` : inp("pl-sd-type", t.key, t.cost, "SF", 0.01))).join("")}
    </tbody></table>`;
  const bidOnly = (t) => `<p class="pl-bidnote">No built-in rates for ${esc(t)}: it is bid pricing from management's estimate on the Assumptions page, plus any cost items you add below.</p>`;
  const t0 = plTrade;
  document.getElementById("priceListBody").innerHTML =
    tabs + card(t0, t0 === "ROOF" ? roof : t0 === "GUTTERS" ? gutters : t0 === "SIDING" ? siding : bidOnly(t0));
  document.getElementById("plStatus").textContent = status || "";
  document.getElementById("plStatus").classList.toggle("ok", /saved|restored/i.test(status || ""));

  const snapshot = () => {
    const L = plDraft;
    const n = (el, d) => { const v = Number(el.value); return el.value !== "" && Number.isFinite(v) && v >= 0 ? v : d; };
    for (const el of document.querySelectorAll(".pl-shingle")) { const sh = L.ROOF.shingles.find((x) => x.key === el.dataset.key); if (sh) sh.cost = n(el, sh.cost); }
    const p = document.querySelector(".pl-pitch"); if (p) L.ROOF.steep.fromPitch = n(p, L.ROOF.steep.fromPitch);
    const st = document.querySelector(".pl-steep"); if (st) L.ROOF.steep.cost = n(st, L.ROOF.steep.cost);
    const rd = document.querySelector(".pl-redeck"); if (rd) L.ROOF.redecking.cost = n(rd, L.ROOF.redecking.cost);
    for (const el of document.querySelectorAll(".pl-gt-type")) { const t = L.GUTTERS.types.find((x) => x.key === el.dataset.key); if (t) t.cost = n(el, t.cost); }
    const six = document.querySelector(".pl-gt-six"); if (six) L.GUTTERS.sixInch.cost = n(six, L.GUTTERS.sixInch.cost);
    const pt = document.querySelector(".pl-gt-paint"); if (pt) L.GUTTERS.paint.cost = n(pt, L.GUTTERS.paint.cost);
    for (const el of document.querySelectorAll(".pl-sd-type")) { const t = L.SIDING.types.find((x) => x.key === el.dataset.key); if (t) t.cost = n(el, t.cost); }
    const ci = (el) => (L[el.dataset.t].costs || []).find((c) => c.key === el.dataset.k);
    for (const el of document.querySelectorAll(".pl-ci-label")) { const c = ci(el); if (c && el.value.trim()) c.label = el.value.trim(); }
    for (const el of document.querySelectorAll(".pl-ci-unit")) { const c = ci(el); if (c) c.unit = el.value; }
    for (const el of document.querySelectorAll(".pl-ci-cost")) { const c = ci(el); if (c) c.cost = n(el, c.cost); }
    const up = (el) => (L[el.dataset.t].upgrades || []).find((u) => u.key === el.dataset.k);
    for (const el of document.querySelectorAll(".pl-up-label")) { const u = up(el); if (u && el.value.trim()) u.label = el.value.trim(); }
    for (const el of document.querySelectorAll(".pl-up-unit")) { const u = up(el); if (u && !el.disabled) u.unit = el.value; }
    for (const el of document.querySelectorAll(".pl-up-price")) { const u = up(el); if (u) u.price = n(el, u.price); }
    for (const el of document.querySelectorAll(".pl-up-cost")) { const u = up(el); if (u) u.cost = n(el, u.cost); }
  };
  for (const btn of document.querySelectorAll(".pl-tab")) btn.addEventListener("click", () => {
    snapshot(); plTrade = btn.dataset.t; renderPriceListPage(document.getElementById("plStatus").textContent); window.scrollTo(0, 0);
  });
  for (const btn of document.querySelectorAll(".pl-ci-add")) btn.addEventListener("click", () => {
    snapshot();
    const t = btn.dataset.t;
    plDraft[t].costs.push({ key: `k${Date.now().toString(36)}${plSeq++}`, label: "", unit: SFC_TRADE_UOM[t] || "EA", cost: 0 });
    renderPriceListPage("Unsaved changes");
    const inputs = document.querySelectorAll(`.pl-ci-label[data-t="${t}"]`); const last = inputs[inputs.length - 1]; if (last) last.focus();
  });
  for (const btn of document.querySelectorAll(".pl-ci-del")) btn.addEventListener("click", () => {
    snapshot();
    plDraft[btn.dataset.t].costs = plDraft[btn.dataset.t].costs.filter((c) => c.key !== btn.dataset.k);
    renderPriceListPage("Unsaved changes");
  });
  for (const btn of document.querySelectorAll(".pl-up-add")) btn.addEventListener("click", () => {
    snapshot();
    const t = btn.dataset.t;
    plDraft[t].upgrades.push({ key: `c${Date.now().toString(36)}${plSeq++}`, label: "", unit: SFC_TRADE_UOM[t] || "EA", price: 0, cost: 0, custom: true });
    renderPriceListPage("Unsaved changes");
    const inputs = document.querySelectorAll(`.pl-up-label[data-t="${t}"]`); const last = inputs[inputs.length - 1]; if (last) last.focus();
  });
  for (const btn of document.querySelectorAll(".pl-up-del")) btn.addEventListener("click", () => {
    snapshot();
    plDraft[btn.dataset.t].upgrades = plDraft[btn.dataset.t].upgrades.filter((u) => u.key !== btn.dataset.k);
    renderPriceListPage("Unsaved changes");
  });
  for (const el of document.querySelectorAll(".pl-up-unit, .pl-ci-unit, .pl-shingle, .pl-up-price")) el.addEventListener("change", () => { snapshot(); renderPriceListPage("Unsaved changes"); });
  for (const el of document.querySelectorAll("#priceListBody input")) el.addEventListener("input", () => { document.getElementById("plStatus").textContent = "Unsaved changes"; document.getElementById("plStatus").classList.remove("ok"); });
  document.getElementById("plSaveBtn").onclick = () => {
    snapshot();
    for (const t of PRICEABLE_TRADES) { plDraft[t].upgrades = plDraft[t].upgrades.filter((u) => !u.custom || u.label); plDraft[t].costs = plDraft[t].costs.filter((c) => c.label); }
    priceListSave(JSON.parse(JSON.stringify(plDraft)));
    renderPriceListPage(`Saved to this browser · ${new Date().toLocaleTimeString("en-US")}`);
  };
  document.getElementById("plResetBtn").onclick = () => {
    priceListReset(); plDraft = JSON.parse(JSON.stringify(priceList));
    renderPriceListPage("Defaults restored");
  };
}

// ---- the claim-breakdown summary page (page 1 of the estimate) ----
function claimSummaryPageHTML(deductibleOverride) {
  const items = state.items;
  const md = state.summary || {};
  const job = state.jobInfo;
  const totals = groupByTrade(items).reduce(
    (a, g) => { a.rcv += g.rcv; a.recDep += g.recDep; a.nonRecDep += g.nonRecDep; a.pwi += g.pwi; a.rps += g.rps || 0; a.acv += g.acv; return a; },
    { rcv: 0, recDep: 0, nonRecDep: 0, pwi: 0, rps: 0, acv: 0 }
  );
  const ded = deductibleOverride != null ? deductibleOverride : md.deductible != null ? Number(md.deductible) || 0 : null;
  const metaRows = [
    ["Job #", job && job.job_number != null ? String(job.job_number) : "—"],
    ["Deductible", ded != null ? fmtUSD(ded) : "—"],
    ["Client Name", sfc.client || (job && job.contact_name) || "—"],
    ["Total Insurance Pays Homeowner", fmtUSD(totals.acv + totals.recDep - (ded || 0))],
    ["Date Printed", new Date().toLocaleDateString("en-US")],
    ["1st Payment (ACV − Deductible)", fmtUSD(totals.acv - (ded || 0))],
  ];
  return `
    <section class="page">
      <div class="doc-head">${LOGO_HTML}
        <p class="doc-eyebrow">Insurance Claim · Trade Breakdown</p>
        <h1 class="doc-title">Claim Summary by Trade</h1>
        <p class="doc-sub">${esc(md.insurance_company || "")}${md.insurance_company && md.date_of_loss ? " · " : ""}${md.date_of_loss ? "Loss dated " + esc(md.date_of_loss) : ""}</p>
      </div>
      <div class="meta-grid">
        ${metaRows.map(([k, v], i) => `<div class="meta-item${i % 2 ? " meta-pay" : ""}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}
      </div>
      <p class="section-label">Summary by Trade</p>
      ${summaryTableHTML(groupByTrade(items), { op: md.totalOP != null ? Number(md.totalOP) : null, tax: md.totalTax != null ? Number(md.totalTax) : null })}
    </section>`;
}

// ---- step: the estimate (four printed pages) ----
function renderSfcEstimate() {
  const rows = sfcPriceRows();
  const m = sfcMoney(rows);
  const md = state.summary || {};
  const client = sfc.client || "—";
  const jobNo = state.jobInfo && state.jobInfo.job_number != null ? String(state.jobInfo.job_number) : "";
  const titleOf = (fallback) => `${esc(client !== "—" ? client : fallback)}${jobNo ? ` <span class="sfc-jobno">· Job #${esc(jobNo)}</span>` : ""}`;
  const crDate = (() => {
    const mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(md.date_of_loss || ""));
    return mm ? `${mm[2]}/${mm[3]}/${mm[1]}` : md.date_of_loss || "—";
  })();
  const subline = [md.insurance_company ? esc(md.insurance_company) : "", crDate !== "—" ? `Claim report ${esc(crDate)}` : ""].filter(Boolean).join(" · ");
  const head = (eyebrow) => `
      <div class="doc-head">${LOGO_HTML}
        <p class="doc-eyebrow">Summit First Construction · ${eyebrow}</p>
        <h1 class="doc-title sfc-title">${titleOf(eyebrow)}</h1>
        <p class="doc-sub">${subline ? `${subline} · ` : ""}Prepared ${new Date().toLocaleDateString("en-US")}</p>
      </div>`;
  const creditedLines = sfcCreditedLines();
  const insRows = rows.filter((x) => x.g.items.length);

  // Page 2 — preliminary pricing: scope (left) + out-of-pocket (right) + signatures.
  const scopeRows = rows
    .filter((x) => x.rcv > 0 || x.ups.length)
    .map((x) => `<li class="scope-trade"><span>${esc(sfcServiceName(x.g.trade))}</span><span class="scope-amt">${fmtUSD(x.contracted)}</span></li>` +
      (x.rcv > 0 ? `<li class="scope-up"><span>(+) Insurance RCV</span><span class="scope-amt">${fmtUSD(x.rcv)}</span></li>` : "") +
      x.ups.map((u) => `<li class="scope-up"><span>(+) ${esc(u.description || "Upgrade")}</span><span class="scope-amt">${fmtUSD(u.price)}</span></li>`).join(""))
    .join("");
  const pricingPage = `
    <section class="page sfc-homeowner">
      ${head("Preliminary Pricing")}
      <div class="ho-grid ho-grid-wide">
        <div>
          <p class="section-label sfc-stack-label">Scope of work</p>
          <ul class="scope-list">
            ${scopeRows || `<li class="scope-trade"><span>Nothing contracted</span><span class="scope-amt">—</span></li>`}
            <li class="scope-adj"><span>(−) Marketing credits</span><span class="scope-amt">${paren(m.marketing)}</span></li>
            <li class="scope-total"><span>Total job value</span><span class="scope-amt">${fmtUSD(m.jobValue)}</span></li>
          </ul>
        </div>
        <div>
          <p class="section-label sfc-stack-label">Your out-of-pocket</p>
          <table class="summary sfc-est sfc-stack ho-table">
            <tbody>
              <tr><td class="left">(+) Deductible</td><td>${fmtUSD(m.deductible)}</td></tr>
              <tr><td class="left">(+) Upgrades</td><td>${fmtUSD(m.upgrades)}</td></tr>
              ${m.nonRecTotal > 0 ? `<tr><td class="left">(+) Non-recoverable depreciation</td><td>${fmtUSD(m.nonRecTotal)}</td></tr>` : ""}
              ${m.rpsTotal > 0 ? `<tr><td class="left">(+) Roof payment schedule <span class="sfc-muted">not paid by insurance</span></td><td>${fmtUSD(m.rpsTotal)}</td></tr>` : ""}
              <tr><td class="left">(−) ACV credits</td><td>${paren(m.acvCredits)}</td></tr>
              ${sfc.marketingCredits.length
                ? sfc.marketingCredits.map((mk) => `<tr><td class="left">(−) ${esc(mk.type)} credit</td><td>${paren(Number(mk.amount) || 0)}</td></tr>`).join("")
                : `<tr><td class="left">(−) Marketing credits</td><td>${fmtUSD(0)}</td></tr>`}
            </tbody>
            <tfoot>
              <tr class="sfc-net"><td class="left">${m.outOfPocket < 0 ? "Credit back to you" : "Out-of-pocket cost"}</td><td>${fmtUSD(Math.abs(m.outOfPocket))}</td></tr>
              <tr class="sfc-net ho-ins"><td class="left">Insurance is paying you</td><td>${fmtUSD(m.insurancePays)}</td></tr>
            </tfoot>
          </table>
        </div>
      </div>
      <div class="ho-sign">
        <div class="ho-sig"><div class="ho-sig-line"></div><div class="ho-sig-label">Client signature</div><div class="ho-sig-date">Date ____________</div></div>
        <div class="ho-sig"><div class="ho-sig-line"></div><div class="ho-sig-label">SFC Sales Rep signature</div><div class="ho-sig-date">Date ____________</div></div>
      </div>
      <div class="ho-notice">
        <p>PLEASE NOTE: CLAIM WILL GO UP AS ADDITIONAL SUPPLEMENTS ARE SUBMITTED!!</p>
        <p>CONTRACT AMOUNT WILL BE ADJUSTED DUE TO APPROVED SUPPLEMENTS AND APPLICABLE SALES TAX.</p>
        <p class="ho-notice-oop">OUT OF POCKET WILL NOT CHANGE DUE TO CLAIM AMOUNT INCREASE, SUBJECT TO THE CURRENT SCOPE OF WORK. IF ADDITIONAL SCOPE IS ADDED, THE OUT OF POCKET WILL CHANGE.</p>
      </div>
      <p class="ho-fine">This is a preliminary estimate, not a binding contract. Final pricing may change with conditions found during the project or changes in scope.</p>
    </section>`;

  // Page 3 — how insurance pays you.
  const insurancePage = `
    <section class="page sfc-homeowner">
      ${head("How Insurance Pays You")}
      <p class="section-label sfc-stack-label">First check — actual cash value (ACV)</p>
      <table class="summary sfc-est sfc-stack ins-table">
        <thead><tr><th class="left">Trade</th><th>ACV</th></tr></thead>
        <tbody>${insRows.map((t) => `
          <tr><td class="left">${esc(sfcServiceName(t.g.trade))}</td><td>${fmtUSD(t.payACV)}</td></tr>`).join("")}
          <tr><td class="left">(−) Your deductible</td><td>${paren(m.deductible)}</td></tr>
        </tbody>
        <tfoot><tr class="sfc-net"><td class="left">Insurance pays you now</td><td>${fmtUSD(m.claimACV - m.deductible)}</td></tr></tfoot>
      </table>
      <p class="section-label sfc-stack-label ins-gap">Second check — recoverable depreciation, paid once the work is complete</p>
      <table class="summary sfc-est sfc-stack ins-table">
        <thead><tr><th class="left">Trade</th><th>Recoverable Dep.</th></tr></thead>
        <tbody>${insRows.map((t) => `
          <tr class="${t.rcv <= 0 ? "struck" : ""}">
            <td class="left">${esc(sfcServiceName(t.g.trade))}${t.rcv <= 0 ? ' <span class="sfc-muted">not contracted</span>' : t.c.creditRec > 0 ? ` <span class="sfc-muted">credited items: <s>${fmtUSD(t.c.creditRec)}</s></span>` : ""}</td>
            <td>${t.rcv <= 0 ? `<s>${fmtUSD(t.c.creditRec)}</s>` : fmtUSD(t.c.rec)}</td>
          </tr>`).join("")}
          ${m.pwiTotal > 0 ? `<tr><td class="left">Paid when incurred</td><td>${fmtUSD(m.pwiTotal)}</td></tr>` : ""}
        </tbody>
        <tfoot><tr class="sfc-net"><td class="left">Insurance pays you on completion</td><td>${fmtUSD(m.recTotal + m.pwiTotal)}</td></tr></tfoot>
      </table>
      <p class="ho-fine">Total from insurance: ${fmtUSD(m.claimACV - m.deductible)} + ${fmtUSD(m.recTotal + m.pwiTotal)} = ${fmtUSD(m.insurancePays)}. ACV is paid on every line whether or not the work is contracted; recoverable depreciation is paid only on work that is completed.</p>
    </section>`;

  // Page 4 — ACV credits, line numbers in front of the descriptions.
  const creditsPage = `
    <section class="page sfc-homeowner">
      ${head("ACV Credits")}
      <p class="section-label sfc-stack-label">Items credited back to you</p>
      <table class="summary sfc-est sfc-credits">
        <thead><tr><th class="left">Trade</th><th class="left">Line</th><th class="left">Item</th><th>ACV</th></tr></thead>
        <tbody>${creditedLines.length ? creditedLines.map((it) => `
          <tr>
            <td class="left">${esc(sfcServiceName(it.trade || "Not Categorized"))}</td>
            <td class="left lineno">${esc(it.displayNumber)}</td>
            <td class="left desc">${esc(it.description)}</td>
            <td>${fmtUSD(sfcLineACV(it))}</td>
          </tr>`).join("") : `<tr><td class="left" colspan="4"><span class="sfc-muted">No items credited.</span></td></tr>`}</tbody>
        <tfoot>
          <tr class="sfc-net"><td class="left" colspan="3">Total ACV credits</td><td>${fmtUSD(m.acvCredits)}</td></tr>
        </tfoot>
      </table>
    </section>`;

  // Page 0 — Price Snapshot (production manager): the whiteboard, one table.
  const per = sfc.perUnit;
  const unit = (n, meas, uom) => (meas > 0 ? `${fmtRate(n / meas)}<span class="per">/${esc(uom)}</span>` : "—");
  const cell = (n, x) => (per && x.uom && x.meas > 0 ? unit(n, x.meas, x.uom) : money0(n));
  const pctCls = (pct) => (pct == null ? "" : pct >= SFC_TARGET_MARGIN ? "pos" : "neg");
  const snapRows = rows.map((x) => `
      <tr>
        <td class="left supp">${esc(sfcSuppStatus(x.g.trade, x.c))}</td>
        <td class="left trade">${esc(x.g.trade)}${x.ups.map((u) => `<div class="snap-sub">– ${esc(u.description || "upgrade")} <span class="snap-up">+${money0(u.price)}</span></div>`).join("")}</td>
        <td class="center">${x.meas != null && x.uom ? `${esc(x.meas)} ${esc(x.uom)}` : ""}</td>
        <td class="sub">${x.payRCV > 0 ? cell(x.payACV, x) : "—"}</td>
        <td class="sub">${x.payRCV > 0 ? cell(x.payRCV, x) : "—"}</td>
        <td>${x.upPrice > 0 ? cell(x.upPrice, x) : "—"}</td>
        <td>${cell(x.contracted, x)}</td>
        <td>${x.priced ? cell(x.cost, x) : "—"}</td>
        <td class="${pctCls(x.pct)}">${x.priced ? fmtPct1(x.pct) : "—"}</td>
      </tr>`).join("");
  const snapshotPage = `
    <section class="page">
      <div class="doc-head">${LOGO_HTML}
        <p class="doc-eyebrow">SFC Estimate · Price Snapshot</p>
        <h1 class="doc-title sfc-title">${titleOf("SFC Estimate")}</h1>
        ${subline ? `<p class="doc-sub">${subline}</p>` : ""}
      </div>
      <table class="summary sfc-est sfc-payout snap">
        <thead>
          <tr>
            <th class="left supp" rowspan="2">Supp Status</th><th class="left" rowspan="2">Trade</th><th class="center" rowspan="2">Quantity</th>
            <th class="group" colspan="2">Ins. Payout Breakdown</th>
            <th rowspan="2">Upgrades</th><th rowspan="2">Contracted Amount</th><th rowspan="2">SFC Cost</th><th rowspan="2">% Profit Margin</th>
          </tr>
          <tr><th class="sub">ACV</th><th class="sub">RCV</th></tr>
        </thead>
        <tbody>
          ${snapRows}
          <tr>
            <td class="supp"></td>
            <td class="left trade">OTHER JOB COSTS</td>
            <td></td><td class="sub"></td><td class="sub"></td><td></td><td></td>
            <td>${money0(m.other)}</td>
            <td></td>
          </tr>
          <tr class="snap-money">
            <td class="supp"></td>
            <td class="left trade">ACV CREDITS</td>
            <td class="center credit-amt">${m.acvCredits > 0 ? fmtUSD(m.acvCredits) : "—"}</td>
            <td class="sub"></td><td class="sub"></td><td></td><td></td><td></td><td></td>
          </tr>
          ${m.marketing > 0 ? `
          <tr class="snap-money">
            <td class="supp"></td>
            <td class="left trade">MARKETING CREDITS<div class="snap-sub">${esc(sfc.marketingCredits.map((mk) => mk.type).join(", "))}</div></td>
            <td></td><td class="sub"></td><td class="sub"></td><td></td>
            <td class="neg">(${fmtUSD(m.marketing)})</td>
            <td></td><td></td>
          </tr>` : ""}
        </tbody>
        <tfoot>
          <tr class="sfc-net">
            <td class="supp"></td>
            <td class="left trade">TOTAL</td>
            <td></td>
            <td class="sub">${money0(m.claimACV)}</td>
            <td class="sub">${money0(m.claimRCV)}</td>
            <td>${m.upgrades > 0 ? money0(m.upgrades) : "—"}</td>
            <td>${money0(m.jobValue)}</td>
            <td>${money0(m.totalCost)}</td>
            <td class="${pctCls(m.netPct)}">${fmtPct1(m.netPct)}</td>
          </tr>
        </tfoot>
      </table>
    </section>`;

  document.getElementById("sfcBody").innerHTML =
    snapshotPage + claimSummaryPageHTML(sfc.deductible != null ? Number(sfc.deductible) || 0 : null) + pricingPage + insurancePage + creditsPage;
  sfcBarMode("estimate");
  document.getElementById("sfcModal").querySelector(".modal-body").scrollTop = 0;
}

// ------------------------------ Wiring ----------------------------------- //
function init() {
  // Job # pickers (empty-state + toolbar). Both share state.jobInfo.
  document.querySelectorAll(".jobpicker").forEach(setupJobPicker);

  // Empty-state big button opens the file picker; the toolbar's "Upload another
  // claim" resets all the way back to the home/empty state (keeping the Job #).
  const openPicker = () => document.getElementById("pdfInput").click();
  document.getElementById("emptyUploadBtn").addEventListener("click", openPicker);
  document.getElementById("pdfBtn").addEventListener("click", resetToEmpty);
  document.getElementById("pdfInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) parsePdf(file);
    e.target.value = ""; // allow re-selecting the same file
  });

  // Deductible box: type it when the claim report does not state one (or correct it).
  document.getElementById("dedInput").addEventListener("input", (e) => {
    if (!state.summary) state.summary = {};
    state.summary.deductible = e.target.value === "" ? null : Math.max(0, Number(e.target.value) || 0);
    e.target.closest(".ded-field").classList.toggle("missing", state.summary.deductible == null);
  });

  // "＋ Price adjustment line": a blank free-form line — name it, type its RCV, depreciation
  // and ACV directly, assign it to any trade — to make the breakdown match what the claim says.
  document.getElementById("addAdjBtn").addEventListener("click", () => {
    if (!state.items.length) return setStatus("Upload a claim first.", "error");
    const n = state.items.filter((it) => it.isAdjustment && String(it.number).startsWith("ADJ")).length;
    state.items.push(newAdjustmentLine({ number: n ? `ADJ${n + 1}` : "ADJ" }));
    renderReview();
    setStatus("Added a price adjustment line at the bottom — name it, type the amounts (ACV can be typed directly), and pick its trade.", "ok");
    const rows = document.querySelectorAll("#reviewBody tr");
    if (rows.length) rows[rows.length - 1].scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // Build the summary — but first reconcile the line items against the claim's own summary page.
  // If everything ties out, build straight away; otherwise show the discrepancy modal.
  document.getElementById("buildBtn").addEventListener("click", () => {
    if (!state.items.length) return setStatus("Nothing to build yet — upload a PDF first.", "error");
    const { ok, rows } = reconcileSummary();
    if (ok) return renderDoc();
    showDiscrepancyModal(rows);
  });

  // Editing the range field clears any status from a previous Apply — otherwise a stale
  // "Ignored invalid token: …" naming an OLD token sits next to freshly typed input.
  document.getElementById("rangeInput").addEventListener("input", () => setStatus(""));

  // Apply the chosen trade and/or structure to the lines named in the range field. One
  // button, one range; each dropdown has a "— no change —" sentinel (value ""), so the
  // user can change trade only, structure only, or both in a single action.
  document.getElementById("applyLinesBtn").addEventListener("click", () => {
    const t = document.getElementById("bulkTradeSelect").value; // "" = no change
    const sid = document.getElementById("bulkStructureSelect").value; // "" = no change
    if (!t && !sid) {
      return setStatus("Pick a trade or structure to apply.", "error");
    }
    const rangeEl = document.getElementById("rangeInput");
    const rangeStr = rangeEl.value.trim();
    if (!rangeStr) {
      return setStatus("Type a line-number range (e.g. 1-5, 7, C1-C3) to apply.", "error");
    }

    const { wanted, bad } = parseLineRange(rangeStr, state.items);
    const badNote = bad.length ? ` Ignored invalid token${bad.length === 1 ? "" : "s"}: ${bad.join(", ")}.` : "";

    const targetIndexes = state.items.reduce((acc, it, i) => {
      if (wanted.has(String(it.displayNumber))) acc.push(i);
      return acc;
    }, []);
    if (!targetIndexes.length) {
      return setStatus(`No line items match that range.${badNote}`, "error");
    }

    targetIndexes.forEach((i) => {
      if (t) {
        state.items[i].trade = t;
        const sel = document.querySelector(`.trade-select[data-i="${i}"]`);
        if (sel) sel.value = t;
      }
      if (sid) {
        state.items[i].structureId = sid;
        const sel = document.querySelector(`.structure-select[data-i="${i}"]`);
        if (sel) sel.value = sid;
      }
    });

    const parts = [];
    if (t) parts.push(t);
    if (sid) parts.push(`“${structureById(sid).name}”`);
    const n = targetIndexes.length;
    rangeEl.value = ""; // clear for the next entry
    setStatus(
      `Set ${n} line item${n === 1 ? "" : "s"} to ${parts.join(" · ")}.${badNote}`,
      bad.length ? "error" : "ok"
    );
  });

  // SFC Estimate: full-screen walk — trades → pricing → ACV credits → estimate.
  document.getElementById("sfcBtn").addEventListener("click", openSfcEstimate);
  document.getElementById("sfcUomBtn").addEventListener("click", () => {
    sfc.perUnit = !sfc.perUnit;
    document.getElementById("sfcUomBtn").setAttribute("aria-pressed", String(sfc.perUnit));
    if (document.getElementById("sfcBody").querySelector(".snap")) renderSfcEstimate();
  });
  document.getElementById("sfcPrintBtn").addEventListener("click", () => window.print());
  document.getElementById("sfcCloseBtn").addEventListener("click", closeSfcModal);
  // Price list page (hidden owner page): takes over the window when the URL asks for it.
  if (priceListRequested()) openPriceList();
  document.getElementById("sfcBackdrop").addEventListener("click", closeSfcModal);

  // Summary modal controls: download, and close via ✕ / backdrop / Escape.
  document.getElementById("downloadModalBtn").addEventListener("click", () => window.print());
  document.getElementById("closeModalBtn").addEventListener("click", closeSummaryModal);
  document.getElementById("modalBackdrop").addEventListener("click", closeSummaryModal);

  // Discrepancy modal: "Fix Discrepancy" returns to the review table; "Build Anyway" builds as-is.
  // Fix Discrepancy: add the price adjustment line that closes the gap, then build.
  document.getElementById("fixDiscBtn").addEventListener("click", () => {
    closeDiscrepancyModal();
    const line = fixDiscrepancy();
    renderReview();
    if (line) {
      setStatus(
        `Added "${line.description}" (line ${line.displayNumber}, PRICE ADJUSTMENT trade): RCV ${fmtUSD(line.rcv)}, ACV ${fmtUSD(itemACV(line))}. The sheet now matches the claim summary — edit or remove the line at the bottom of the table.`,
        "ok"
      );
    }
    renderDoc();
  });
  document.getElementById("buildAnywayBtn").addEventListener("click", () => {
    closeDiscrepancyModal();
    renderDoc();
  });
  document.getElementById("discBackdrop").addEventListener("click", closeDiscrepancyModal);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("discrepancyModal").hidden) return closeDiscrepancyModal();
    if (!document.getElementById("sfcModal").hidden) return closeSfcModal();
    if (!document.getElementById("summaryModal").hidden) closeSummaryModal();
  });

  // Sample buttons (empty state + toolbar).
  document.getElementById("sampleBtn").addEventListener("click", loadSample);
  document.getElementById("emptySampleBtn").addEventListener("click", loadSample);

  // Drag & drop a PDF onto the toolbar or the empty-state area.
  [document.getElementById("toolbar"), document.getElementById("empty")].forEach((zone) => {
    ["dragover", "drop"].forEach((evt) => zone.addEventListener(evt, (e) => e.preventDefault()));
    zone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files[0];
      if (file) parsePdf(file);
    });
  });
}

document.addEventListener("DOMContentLoaded", init);
