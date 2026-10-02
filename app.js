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
const TRADE_ORDER = [
  "ROOF",
  "GUTTERS",
  "SIDING",
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

function renderReview() {
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
    `<main class="doc" style="max-width:none;margin:0;padding:0"><section class="page">` +
    `<div class="sum-headmeta">${headMetaHTML}</div>` +
    blocks.map((b) => `<div class="sum-block">${b}</div>`).join("") +
    `</section></main>`;
  const headH = probe.querySelector(".sum-headmeta").offsetHeight;
  const blockHs = [...probe.querySelectorAll(".sum-block")].map((el) => el.offsetHeight);
  probe.remove();
  const chunks = packRowsByHeight(
    blockHs,
    (ci) => PRINT_USABLE_PX - (ci === 0 ? headH : 0) - PAGE_SLACK
  );
  const pagesHTML = chunks
    .map(
      (idxs, ci) =>
        `<section class="page">` +
        (ci === 0 ? `<div class="sum-headmeta">${headMetaHTML}</div>` : "") +
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
            <div class="trade-page-title"><span class="bar" style="background:${g.color}"></span><h2>${esc(g.trade)}${cont ? ' <span class="cont-tag">(cont.)</span>' : ""}</h2></div>${totals}
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
  //   Total Insurance Pays Homeowner = RCV − Non-Recoverable Dep. − RPS customer portion − Deductible − Paid When Incurred
  //   1st Payment (ACV check)        = ACV − Deductible
  // where ACV already nets PWI and both depreciation buckets (same formula everywhere).
  // Deductible is the claim's stated deductible (0 when the parser did not find one).
  const claimTotals = groupByTrade(items).reduce(
    (a, g) => { a.rcv += g.rcv; a.nonRecDep += g.nonRecDep; a.pwi += g.pwi; a.rps += g.rps || 0; a.acv += g.acv; return a; },
    { rcv: 0, nonRecDep: 0, pwi: 0, rps: 0, acv: 0 }
  );
  const deductible = md.deductible != null ? Number(md.deductible) || 0 : 0;
  const insurancePays = claimTotals.rcv - claimTotals.nonRecDep - claimTotals.rps - deductible - claimTotals.pwi;
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
      <div class="doc-head">
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
        <section class="page structure-divider">
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
//   Contractor pricing  the ACV credit pool beside the contracted trades; per trade a "Contractor
//                  Pricing" box — what SFC charges ABOVE the insurance RCV so the trade makes
//                  margin (siding allowed at 9,000, costs 7,000, SFC needs 14,000 → 5,000). It is
//                  SFC's price, not the homeowner's money, so it is not capped by the pool. The
//                  ACV credits (insurance money for work we are not doing) offset what the
//                  homeowner owes. Margins update live.
//   Estimate       four printed pages: 1 Claim Summary by Trade (page 1 of the breakdown),
//                  2 Preliminary Pricing (scope + out-of-pocket, signatures), 3 How Insurance
//                  Pays You (ACV, recoverable depreciation), 4 ACV Credits.
//
// Money model (every page ties to it):
//   Contracted Amount (trade) = contracted RCV + upgrades + contractor pricing
//   Total job value           = Σ Contracted Amount − marketing credits
//   Insurance pays            = ACV on EVERY line − deductible (first check)
//                             + recoverable dep (+ paid-when-incurred) on contracted lines
//   Out-of-pocket             = job value − insurance pays
//                             = deductible + upgrades + contractor pricing + non-rec dep
//                               + RPS customer portion − ACV credits − marketing
//   (negative out-of-pocket = a credit back to the homeowner)
const SFC_TRADE_UOM = { ROOF: "SQ", SIDING: "SF", GUTTERS: "LF", PAINT: "SF", WINDOWS: "EA", FENCE: "LF", GARAGE: "SF", SOLAR: "PNL" };
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
  ROOF: "Roofing Services", GUTTERS: "Gutter Services", SIDING: "Siding Services", WINDOWS: "Window Services",
  PAINT: "Painting Services", SOLAR: "Solar Services", FENCE: "Fence Services", GARAGE: "Garage Services",
  MISC: "Miscellaneous", "PERSONAL PROPERTY": "Personal Property", "PRICE ADJUSTMENT": "Price Adjustment",
};
const sfcServiceName = (t) =>
  SFC_TRADE_SERVICE[t] || `${String(t).toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase())} Services`;

// credits: lineKey -> true when the line's ACV is credited (line leaves the contracted scope).
// lineKey = the line's index in state.items — stable for one parsed claim; itemsRef remembers
// which claim the state belongs to so a new upload starts clean.
// adjust: trade -> contractor pricing, dollars SFC charges above the insurance RCV for that trade.
// mode: trade -> "measure" | "bid". unlocked / rateEdits: a history rate is locked at the median
// until the estimator clicks Unlock; the typed $/unit then replaces the median.
let sfc = {
  pricing: null, measurements: {}, bids: {}, unlocked: {}, rateEdits: {}, mode: {}, client: "", perUnit: false,
  rates: null, credits: {}, deductible: null, step: 0, itemsRef: null,
  upgrades: [], marketingCredits: [], adjust: {},
};
let sfcSeq = 1;

function sfcIsBid(trade) {
  return SFC_BID_TRADES.has(trade) || !sfcRateFor(trade);
}
// How a trade is priced: "measure" (history rate × measurement) or "bid" (typed cost). The
// default is bid for the bid trades and for any trade with no usable history.
function sfcMode(trade) {
  if (sfc.mode[trade] === "measure" || sfc.mode[trade] === "bid") return sfc.mode[trade];
  return sfcIsBid(trade) ? "bid" : "measure";
}

// "28.40 SQ" / "1,234.5 SF" → { value, unit }; null when the quantity has no unit.
function parseQuantity(q) {
  const m = /([\d,]*\.?\d+)\s*([A-Za-z]+)/.exec(String(q || ""));
  if (!m) return null;
  return { value: Number(m[1].replace(/,/g, "")), unit: m[2].toUpperCase() };
}
// Largest quantity in the trade's unit among its lines — a suggestion the form can overwrite.
function suggestMeasurement(items, uom) {
  let best = 0;
  for (const it of items) {
    const q = parseQuantity(it.quantity);
    if (q && q.unit === uom && q.value > best) best = q.value;
  }
  return best || null;
}
async function fetchLivePricing() {
  if (sfc.pricing) return sfc.pricing;
  const res = await fetch(`${BACKEND_URL}/api/analytics/live-pricing?population=all&window=all`);
  if (!res.ok) throw new Error(`Pricing service error (${res.status}).`);
  sfc.pricing = await res.json();
  return sfc.pricing;
}
// Every trade on the claim that carries RCV, in summary order.
function sfcTradeGroups() {
  return groupByTrade(state.items).filter((g) => g.rcv > 0);
}
const sfcIsClaimOnly = (trade) => !SFC_TRADE_UOM[trade];
// Live Pricing row for a trade, or null when the history is too thin to price from.
function sfcRateFor(trade) {
  const t = ((sfc.pricing && sfc.pricing.trades) || []).find((x) => x.trade === trade);
  if (!t || t.n < SFC_MIN_JOBS || t.cost.median == null) return null;
  return t;
}
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
  return sfc.upgrades.filter((u) => u.trade === trade);
}
function sfcMarketingTotal() {
  return sfc.marketingCredits.reduce((a, m) => a + (Number(m.amount) || 0), 0);
}
function sfcAdjustTotal() {
  return Object.values(sfc.adjust).reduce((a, v) => a + (Number(v) || 0), 0);
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
      const adjust = Number(sfc.adjust[g.trade]) || 0;
      const contracted = c.rcv + upPrice + adjust;
      const uom = SFC_TRADE_UOM[g.trade];
      const meas = sfc.measurements[g.trade];
      let cost = null, priced = false;
      if (c.rcv > 0 && !sfcIsClaimOnly(g.trade)) {
        if (sfcMode(g.trade) === "bid") {
          const bid = sfc.bids[g.trade];
          priced = bid != null && bid > 0;
          cost = priced ? bid + upCost : null;
        } else {
          const rate = sfcRateFor(g.trade);
          const perUnit = rate ? (sfc.unlocked[g.trade] && sfc.rateEdits[g.trade] != null ? sfc.rateEdits[g.trade] : rate.cost.median) : null;
          priced = perUnit != null && meas != null && meas > 0;
          cost = priced ? perUnit * meas + upCost : null;
        }
      } else if (ups.length && upCost > 0) {
        priced = true; cost = upCost;
      }
      const pct = priced && contracted > 0 ? ((contracted - cost) / contracted) * 100 : null;
      return {
        g, c, ups, upPrice, upCost, adjust, contracted, uom,
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
  const adjust = rows.reduce((a, r) => a + r.adjust, 0);
  const recTotal = rows.reduce((a, r) => a + r.c.rec, 0);
  const pwiTotal = rows.reduce((a, r) => a + r.c.pwi, 0);
  const nonRecTotal = rows.reduce((a, r) => a + r.c.nonRec, 0);
  const rpsTotal = rows.reduce((a, r) => a + r.c.rps, 0);
  const tradeCost = rows.filter((r) => r.priced).reduce((a, r) => a + r.cost, 0);
  const acvCredits = sfcTotalCredits();
  const marketing = sfcMarketingTotal();
  const deductible = sfc.deductible != null ? Number(sfc.deductible) || 0 : 0;
  const jobValue = payout + upgrades + adjust - marketing;
  const other = jobValue * (SFC_OTHER_PCT / 100);
  const totalCost = tradeCost + other;
  const netPct = jobValue > 0 ? ((jobValue - totalCost) / jobValue) * 100 : null;
  const insurancePays = claimACV - deductible + recTotal + pwiTotal;
  const outOfPocket = Math.round((jobValue - insurancePays) * 100) / 100; // < 0 → credit back to the homeowner
  return { payout, payoutACV, claimRCV, claimACV, upgrades, adjust, recTotal, pwiTotal, nonRecTotal, rpsTotal, tradeCost, acvCredits, marketing, deductible, jobValue, other, totalCost, netPct, insurancePays, outOfPocket };
}

// ---- flow ----
// Steps: 0..n-1 trade screens, n pricing, n+1 ACV credits, n+2 estimate.
const sfcStepCount = () => sfcTradeGroups().length + 3;
async function openSfcEstimate() {
  if (!state.items.length) return setStatus("Nothing to estimate yet — upload a PDF first.", "error");
  const groups = sfcTradeGroups();
  if (!groups.length) return setStatus("No line items carry RCV yet.", "error");
  if (sfc.itemsRef !== state.items) {
    sfc.itemsRef = state.items;
    sfc.credits = {}; sfc.measurements = {}; sfc.bids = {}; sfc.unlocked = {}; sfc.rateEdits = {}; sfc.mode = {};
    sfc.deductible = null; sfc.client = ""; sfc.upgrades = []; sfc.marketingCredits = []; sfc.adjust = {};
  }
  if (!sfc.client && state.jobInfo && state.jobInfo.contact_name) sfc.client = state.jobInfo.contact_name;
  const md = state.summary || {};
  if (sfc.deductible == null && md.deductible != null) sfc.deductible = Number(md.deductible) || 0;

  document.getElementById("sfcModal").hidden = false;
  document.body.classList.add("sfc-open");
  sfcBarMode("trade");
  const body = document.getElementById("sfcBody");
  body.innerHTML = `<p class="sfc-note">Pulling SFC pricing…</p>`;
  try {
    await fetchLivePricing();
  } catch (e) {
    body.innerHTML = `<p class="sfc-note sfc-error">${esc(e.message || "Could not reach the pricing service.")}</p>`;
    return;
  }
  for (const g of groups) {
    if (sfcIsClaimOnly(g.trade)) continue;
    if (sfc.measurements[g.trade] == null) sfc.measurements[g.trade] = suggestMeasurement(g.items, SFC_TRADE_UOM[g.trade]);
  }
  sfc.step = 0;
  renderSfcStep();
}
function closeSfcModal() {
  document.getElementById("sfcModal").hidden = true;
  document.body.classList.remove("sfc-open");
}
// Step bar in the header: Trades · Pricing · ACV credits · Estimate (earlier steps clickable).
function sfcBarMode(mode) {
  const n = sfcTradeGroups().length;
  const cur = mode === "trade" ? 0 : mode === "pricing" ? 1 : mode === "allocate" ? 2 : 3;
  const labels = ["Trades", "Pricing", "Contractor pricing", "Estimate"];
  const bar = document.getElementById("sfcSteps");
  if (bar) {
    bar.innerHTML = labels
      .map((l, i) => `<button type="button" class="sfc-stepbtn${i === cur ? " current" : i < cur ? " done" : ""}" data-step="${i}" ${i > cur ? "disabled" : ""}><span class="n">${i + 1}</span>${esc(l)}</button>`)
      .join('<span class="sfc-stepsep">›</span>');
    for (const b of bar.querySelectorAll(".sfc-stepbtn:not([disabled])")) {
      b.addEventListener("click", () => {
        const i = Number(b.dataset.step);
        sfc.step = i === 0 ? 0 : i === 1 ? n : i === 2 ? n + 1 : n + 2;
        renderSfcStep();
      });
    }
  }
  document.getElementById("sfcUomBtn").hidden = mode !== "estimate";
  document.getElementById("sfcPrintBtn").hidden = mode !== "estimate";
  document.getElementById("sfcUomBtn").setAttribute("aria-pressed", String(sfc.perUnit));
}
function renderSfcStep() {
  const n = sfcTradeGroups().length;
  sfc.step = Math.max(0, Math.min(sfc.step, n + 2));
  document.getElementById("sfcModal").querySelector(".modal-body").scrollTop = 0;
  document.getElementById("sfcBody").classList.toggle("sfc-work", sfc.step < n + 2);
  if (sfc.step < n) { sfcBarMode("trade"); renderSfcTrade(sfcTradeGroups()[sfc.step], sfc.step, n); }
  else if (sfc.step === n) { sfcBarMode("pricing"); renderSfcPricing(); }
  else if (sfc.step === n + 1) { sfcBarMode("allocate"); renderSfcAllocate(); }
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
    nextLabel: idx + 1 < n ? "Next →" : "Pricing →",
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

// ---- step: pricing ----
function renderSfcPricing() {
  const groups = sfcJobTrades();
  const rows = groups
    .map((g) => {
      const c = sfcContracted(g);
      const ups = sfcUpgradesFor(g.trade);
      const uom = SFC_TRADE_UOM[g.trade];
      const rate = sfcRateFor(g.trade);
      const meas = sfc.measurements[g.trade];
      const note =
        (c.credited ? `<span class="sfc-credited-note">${c.credited} line${c.credited === 1 ? "" : "s"} credited</span>` : "") +
        (ups.length ? `<span class="sfc-upgrade-note">${ups.length} upgrade${ups.length === 1 ? "" : "s"} +${fmtUSD(ups.reduce((a, u) => a + (Number(u.price) || 0), 0))}</span>` : "");
      const tradeCell = `<td class="trade"><span class="trade-cell"><span class="trade-swatch" style="background:${g.color}"></span>${esc(g.trade)}</span>${note}</td>`;
      if (c.rcv <= 0) {
        return `
      <tr class="sfc-claimonly">${tradeCell}<td class="num rcv">${fmtUSD(0)}</td><td class="num meas"></td>
        <td class="cost"><span class="sfc-rate"><em>${ups.length ? "upgrades only" : "credited"}</em></span></td></tr>`;
      }
      if (sfcIsClaimOnly(g.trade)) {
        return `
      <tr class="sfc-claimonly">${tradeCell}<td class="num rcv">${fmtUSD(c.rcv)}</td><td class="num meas"></td>
        <td class="cost"><span class="sfc-rate"><em>claim only</em></span></td></tr>`;
      }
      const bid = sfcMode(g.trade) === "bid";
      const modeSwitch = `<span class="sfc-mode" role="group" aria-label="Price by">
          <button type="button" class="sfc-mode-btn sfc-mode-measure" data-trade="${esc(g.trade)}" aria-pressed="${!bid}">Measure</button>
          <button type="button" class="sfc-mode-btn sfc-mode-bid" data-trade="${esc(g.trade)}" aria-pressed="${bid}">Bid</button>
        </span>`;
      const unlocked = !!sfc.unlocked[g.trade];
      const median = rate ? Math.round(rate.cost.median * 100) / 100 : null;
      const rateVal = sfc.rateEdits[g.trade] != null ? sfc.rateEdits[g.trade] : median;
      const rateHTML = modeSwitch + (bid
        ? `<span class="sfc-field"><input class="input sfc-bid" type="number" min="0" step="1" inputmode="decimal"
                  data-trade="${esc(g.trade)}" value="${sfc.bids[g.trade] != null ? esc(sfc.bids[g.trade]) : ""}" placeholder="$" />
           <span class="uom">bid</span></span>`
        : !rate
          ? `<span class="sfc-field"><span class="sfc-rate"><em>no SFC rate yet — use Bid</em></span></span>`
          : unlocked
            ? `<span class="sfc-field"><input class="input sfc-rate-in" type="number" min="0" step="0.01" inputmode="decimal"
                    data-trade="${esc(g.trade)}" value="${esc(rateVal)}" />
               <span class="uom">/ ${esc(uom)}</span>
               <button type="button" class="btn btn-ghost btn-lock sfc-lock" data-trade="${esc(g.trade)}" title="Lock back to the median ${fmtRate(median)}">Lock</button></span>`
            : `<span class="sfc-field"><span class="sfc-rate"><b>${fmtRate(median)}</b> / ${esc(uom)}</span>
               <button type="button" class="btn btn-ghost btn-lock sfc-unlock" data-trade="${esc(g.trade)}" title="Unlock to type a different rate">Unlock</button></span>`);
      return `
      <tr>${tradeCell}
        <td class="num rcv">${fmtUSD(c.rcv)}</td>
        <td class="num meas"><span class="sfc-field">
          <input class="input sfc-meas" type="number" min="0" step="0.01" inputmode="decimal"
                 data-trade="${esc(g.trade)}" value="${meas != null ? esc(meas) : ""}" placeholder="0" />
          <span class="uom">${esc(uom)}</span>
        </span></td>
        <td class="cost">${rateHTML}</td>
      </tr>`;
    })
    .join("");
  const tradeOptions = (sel) =>
    [...new Set([...TRADE_ORDER, ...groups.map((g) => g.trade)])]
      .map((t) => `<option value="${esc(t)}" ${t === sel ? "selected" : ""}>${esc(t)}</option>`).join("");
  const upgradeRows = sfc.upgrades.map((u) => `
      <tr data-id="${u.id}">
        <td><select class="input sfc-up-trade" data-id="${u.id}">${tradeOptions(u.trade)}</select></td>
        <td><input class="input input-wide sfc-up-desc" type="text" data-id="${u.id}" value="${esc(u.description || "")}" placeholder="e.g. Class 4 upgrade" /></td>
        <td class="num"><input class="input sfc-up-price" type="number" min="0" step="1" inputmode="decimal" data-id="${u.id}" value="${u.price ? esc(u.price) : ""}" placeholder="$ price" /></td>
        <td class="num"><input class="input sfc-up-cost" type="number" min="0" step="1" inputmode="decimal" data-id="${u.id}" value="${u.cost ? esc(u.cost) : ""}" placeholder="$ SFC cost" /></td>
        <td class="check"><button type="button" class="btn btn-ghost btn-lock sfc-up-del" data-id="${u.id}" title="Remove">✕</button></td>
      </tr>`).join("");
  const marketingRows = sfc.marketingCredits.map((m) => `
      <tr data-id="${m.id}">
        <td><select class="input sfc-mk-type" data-id="${m.id}">${SFC_MARKETING_TYPES.map((t) => `<option value="${esc(t)}" ${t === m.type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></td>
        <td class="num"><input class="input sfc-mk-amount" type="number" min="0" step="1" inputmode="decimal" data-id="${m.id}" value="${m.amount ? esc(m.amount) : ""}" placeholder="$" /></td>
        <td class="check"><button type="button" class="btn btn-ghost btn-lock sfc-mk-del" data-id="${m.id}" title="Remove">✕</button></td>
      </tr>`).join("");

  document.getElementById("sfcBody").innerHTML = sfcNavHTML({ step: "Pricing", trade: "Measurements, upgrades, credits", nextLabel: "Contractor pricing →" }) + `
    <div class="sfc-controls">
      <label>Client <input id="sfcClient" class="input input-wide" type="text" value="${esc(sfc.client)}" placeholder="Homeowner" /></label>
      <label>Deductible <span class="sfc-field"><input id="sfcDeductible" class="input" type="number" min="0" step="0.01" inputmode="decimal"
             value="${sfc.deductible != null ? esc(sfc.deductible) : ""}" placeholder="$" title="From the claim when stated; type it when the appraisal leaves it off" /></span></label>
    </div>
    <table class="sfc-form">
      <thead><tr><th class="trade">Trade</th><th class="num rcv">Contracted RCV</th><th class="num meas">Measurement</th><th class="cost">SFC cost</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="section-label sfc-upgrades-label">Upgrades &amp; add-ons <span class="sfc-muted">priced on top of the claim — raise the Contracted Amount, not the insurance payout</span></p>
    <table class="sfc-form sfc-upgrades">
      <thead><tr><th class="trade">Trade</th><th>Description</th><th class="num">Price</th><th class="num">SFC cost</th><th class="check"></th></tr></thead>
      <tbody id="sfcUpgradeRows">${upgradeRows}</tbody>
    </table>
    <div class="sfc-upgrade-foot"><button type="button" id="sfcAddUpgrade" class="btn btn-ghost">＋ Add upgrade</button></div>
    <p class="section-label sfc-upgrades-label">Marketing credits <span class="sfc-muted">come off the homeowner's price</span></p>
    <table class="sfc-form sfc-upgrades sfc-marketing">
      <thead><tr><th class="trade">Credit</th><th class="num">Amount</th><th class="check"></th></tr></thead>
      <tbody id="sfcMarketingRows">${marketingRows}</tbody>
    </table>
    <div class="sfc-upgrade-foot"><button type="button" id="sfcAddMarketing" class="btn btn-ghost">＋ Add marketing credit</button></div>`;

  const snapshot = () => {
    for (const inp of document.querySelectorAll(".sfc-meas")) { const v = Number(inp.value); sfc.measurements[inp.dataset.trade] = v > 0 ? v : null; }
    for (const inp of document.querySelectorAll(".sfc-bid")) { const v = Number(inp.value); sfc.bids[inp.dataset.trade] = v > 0 ? v : null; }
    for (const inp of document.querySelectorAll(".sfc-rate-in")) { const v = Number(inp.value); sfc.rateEdits[inp.dataset.trade] = v > 0 ? v : null; }
    for (const u of sfc.upgrades) {
      const q = (cls) => document.querySelector(`.${cls}[data-id="${u.id}"]`);
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
  };
  const rerender = () => { snapshot(); renderSfcPricing(); };
  for (const btn of document.querySelectorAll(".sfc-mode-btn")) {
    btn.addEventListener("click", () => { snapshot(); sfc.mode[btn.dataset.trade] = btn.classList.contains("sfc-mode-bid") ? "bid" : "measure"; renderSfcPricing(); });
  }
  for (const btn of document.querySelectorAll(".sfc-unlock")) btn.addEventListener("click", () => { snapshot(); sfc.unlocked[btn.dataset.trade] = true; renderSfcPricing(); });
  for (const btn of document.querySelectorAll(".sfc-lock")) btn.addEventListener("click", () => { snapshot(); sfc.unlocked[btn.dataset.trade] = false; sfc.rateEdits[btn.dataset.trade] = null; renderSfcPricing(); });
  document.getElementById("sfcAddUpgrade").addEventListener("click", () => {
    snapshot();
    sfc.upgrades.push({ id: sfcSeq++, trade: groups[0] ? groups[0].trade : TRADE_ORDER[0], description: "", price: 0, cost: 0 });
    renderSfcPricing();
    const last = document.querySelector("#sfcUpgradeRows tr:last-child .sfc-up-desc"); if (last) last.focus();
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
    sfc.upgrades = sfc.upgrades.filter((u) => u.price > 0 || u.description);
    sfc.marketingCredits = sfc.marketingCredits.filter((m) => m.amount > 0);
  };
  sfcWireNav(finish, finish);
}

// ---- step: contractor pricing (the live matrix) ----
// Per contracted trade, what SFC charges above the insurance RCV. The ACV credits pool sits
// beside it: those credits offset what the homeowner owes (deductible + upgrades + contractor
// pricing); the homeowner-balance box at the bottom of the pool updates live.
function renderSfcAllocate() {
  const rows = sfcPriceRows();
  const m = sfcMoney(rows);
  const pool = m.acvCredits;
  const credited = sfcCreditedLines();
  const byTrade = new Map();
  for (const it of credited) {
    const t = it.trade || "Not Categorized";
    if (!byTrade.has(t)) byTrade.set(t, []);
    byTrade.get(t).push(it);
  }
  const poolHTML = pool > 0
    ? [...byTrade.entries()].map(([t, its]) => `
        <div class="alloc-pool-trade">
          <div class="alloc-pool-head"><span class="trade-cell"><span class="trade-swatch" style="background:${TRADE_COLORS[t] || "#94a3b8"}"></span>${esc(t)}</span><b>${fmtUSD(its.reduce((a, it) => a + sfcLineACV(it), 0))}</b></div>
          ${its.map((it) => `<div class="alloc-pool-line"><span>${esc(it.displayNumber)} · ${esc(it.description)}</span><span>${fmtUSD(sfcLineACV(it))}</span></div>`).join("")}
        </div>`).join("")
    : `<p class="sfc-note">No lines credited — go back to the trades and tick "Credit ACV" on the work the homeowner is not doing.</p>`;
  const balanceHTML = (mm) => `
        <div class="alloc-pool-split"><span>(+) Deductible</span><b>${fmtUSD(mm.deductible)}</b></div>
        <div class="alloc-pool-split"><span>(+) Upgrades</span><b>${fmtUSD(mm.upgrades)}</b></div>
        <div class="alloc-pool-split"><span>(+) Contractor pricing</span><b>${fmtUSD(mm.adjust)}</b></div>
        ${mm.nonRecTotal > 0 ? `<div class="alloc-pool-split"><span>(+) Non-recoverable dep.</span><b>${fmtUSD(mm.nonRecTotal)}</b></div>` : ""}
        ${mm.rpsTotal > 0 ? `<div class="alloc-pool-split"><span>(+) Roof payment schedule</span><b>${fmtUSD(mm.rpsTotal)}</b></div>` : ""}
        <div class="alloc-pool-split"><span>(−) ACV credits</span><b>${paren(mm.acvCredits)}</b></div>
        ${mm.marketing > 0 ? `<div class="alloc-pool-split"><span>(−) Marketing credits</span><b>${paren(mm.marketing)}</b></div>` : ""}
        <div class="alloc-pool-total ${mm.outOfPocket < 0 ? "pos" : ""}"><span>${mm.outOfPocket < 0 ? "Credit back to homeowner" : "Homeowner out-of-pocket"}</span><b>${fmtUSD(Math.abs(mm.outOfPocket))}</b></div>`;

  const tradeRows = rows.filter((x) => x.rcv > 0 || x.ups.length).map((x) => `
      <tr data-trade="${esc(x.g.trade)}">
        <td class="left trade">${esc(x.g.trade)}${x.ups.map((u) => `<div class="snap-sub">– ${esc(u.description || "upgrade")} <span class="snap-up">+${money0(u.price)}</span></div>`).join("")}</td>
        <td>${money0(x.rcv + x.upPrice)}</td>
        <td class="alloc-in"><input class="input sfc-adjust" type="number" min="0" step="1" inputmode="decimal" data-trade="${esc(x.g.trade)}" value="${x.adjust ? esc(x.adjust) : ""}" placeholder="$0" /></td>
        <td class="alloc-contracted">${money0(x.contracted)}</td>
        <td>${x.priced ? money0(x.cost) : "—"}</td>
        <td class="alloc-pct ${x.pct == null ? "" : x.pct >= SFC_TARGET_MARGIN ? "pos" : "neg"}">${x.priced ? fmtPct1(x.pct) : "—"}</td>
      </tr>`).join("");

  document.getElementById("sfcBody").innerHTML = sfcNavHTML({ step: "Contractor pricing", trade: "Price the work above insurance — ACV credits offset what the homeowner owes", nextLabel: "Build estimate →" }) + `
    <div class="alloc-grid">
      <div class="alloc-pool">
        <p class="section-label">ACV credits — work we are not doing</p>
        ${poolHTML}
        <div class="alloc-pool-total"><span>ACV credits</span><b>${fmtUSD(pool)}</b></div>
        <p class="section-label alloc-balance-label">Homeowner balance</p>
        <div id="allocBalance">${balanceHTML(m)}</div>
      </div>
      <div class="alloc-trades">
        <p class="section-label">Contracted trades</p>
        <table class="summary sfc-est alloc-table">
          <thead><tr><th class="left">Trade</th><th>RCV + Upgrades</th><th>Contractor Pricing</th><th>Contracted Amount</th><th>SFC Cost</th><th>Margin</th></tr></thead>
          <tbody>${tradeRows}</tbody>
          <tfoot><tr class="sfc-net">
            <td class="left">TOTAL <span class="sfc-muted">after ${SFC_OTHER_PCT}% other job costs</span></td>
            <td>${money0(m.payout + m.upgrades)}</td>
            <td id="allocTotAdjust">${money0(m.adjust)}</td>
            <td id="allocTotContracted">${money0(m.jobValue + m.marketing)}</td>
            <td id="allocTotCost">${money0(m.totalCost)}</td>
            <td id="allocTotPct" class="${m.netPct == null ? "" : m.netPct >= SFC_TARGET_MARGIN ? "pos" : "neg"}">${fmtPct1(m.netPct)}</td>
          </tr></tfoot>
        </table>
        <p class="sfc-rates">Contractor pricing is what SFC charges above the insurance RCV so the trade makes margin. It raises the Contracted Amount; the homeowner covers it with their ACV credits first, then out of pocket.</p>
      </div>
    </div>`;

  const inputs = [...document.querySelectorAll(".sfc-adjust")];
  const live = () => {
    for (const o of inputs) { const v = Math.max(0, Number(o.value) || 0); if (v > 0) sfc.adjust[o.dataset.trade] = v; else delete sfc.adjust[o.dataset.trade]; }
    const rows2 = sfcPriceRows();
    const m2 = sfcMoney(rows2);
    for (const x of rows2) {
      const tr = document.querySelector(`.alloc-table tr[data-trade="${CSS.escape(x.g.trade)}"]`);
      if (!tr) continue;
      tr.querySelector(".alloc-contracted").textContent = money0(x.contracted);
      const pc = tr.querySelector(".alloc-pct");
      pc.textContent = x.priced ? fmtPct1(x.pct) : "—";
      pc.className = `alloc-pct ${x.pct == null ? "" : x.pct >= SFC_TARGET_MARGIN ? "pos" : "neg"}`;
    }
    document.getElementById("allocBalance").innerHTML = balanceHTML(m2);
    document.getElementById("allocTotAdjust").textContent = money0(m2.adjust);
    document.getElementById("allocTotContracted").textContent = money0(m2.jobValue + m2.marketing);
    document.getElementById("allocTotCost").textContent = money0(m2.totalCost);
    const tp = document.getElementById("allocTotPct");
    tp.textContent = fmtPct1(m2.netPct);
    tp.className = m2.netPct == null ? "" : m2.netPct >= SFC_TARGET_MARGIN ? "pos" : "neg";
  };
  for (const inp of inputs) inp.addEventListener("input", live);
  sfcWireNav(live, live);
}

// ---- the claim-breakdown summary page (page 1 of the estimate) ----
function claimSummaryPageHTML(deductibleOverride) {
  const items = state.items;
  const md = state.summary || {};
  const job = state.jobInfo;
  const totals = groupByTrade(items).reduce(
    (a, g) => { a.rcv += g.rcv; a.nonRecDep += g.nonRecDep; a.pwi += g.pwi; a.rps += g.rps || 0; a.acv += g.acv; return a; },
    { rcv: 0, nonRecDep: 0, pwi: 0, rps: 0, acv: 0 }
  );
  const ded = deductibleOverride != null ? deductibleOverride : md.deductible != null ? Number(md.deductible) || 0 : null;
  const metaRows = [
    ["Job #", job && job.job_number != null ? String(job.job_number) : "—"],
    ["Deductible", ded != null ? fmtUSD(ded) : "—"],
    ["Client Name", sfc.client || (job && job.contact_name) || "—"],
    ["Total Insurance Pays Homeowner", fmtUSD(totals.rcv - totals.nonRecDep - totals.rps - (ded || 0) - totals.pwi)],
    ["Date Printed", new Date().toLocaleDateString("en-US")],
    ["1st Payment (ACV − Deductible)", fmtUSD(totals.acv - (ded || 0))],
  ];
  return `
    <section class="page">
      <div class="doc-head">
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
      <div class="doc-head">
        <p class="doc-eyebrow">Summit First Construction · ${eyebrow}</p>
        <h1 class="doc-title sfc-title">${titleOf(eyebrow)}</h1>
        <p class="doc-sub">${subline ? `${subline} · ` : ""}Prepared ${new Date().toLocaleDateString("en-US")}</p>
      </div>`;
  const creditedLines = sfcCreditedLines();
  const insRows = rows.filter((x) => x.g.items.length);

  // Page 2 — preliminary pricing: scope (left) + out-of-pocket (right) + signatures.
  const scopeRows = rows
    .filter((x) => x.rcv > 0 || x.ups.length || x.adjust > 0)
    .map((x) => `<li class="scope-trade"><span>${esc(sfcServiceName(x.g.trade))}</span><span class="scope-amt">${fmtUSD(x.contracted)}</span></li>` +
      (x.rcv > 0 ? `<li class="scope-up"><span>(+) Insurance RCV</span><span class="scope-amt">${fmtUSD(x.rcv)}</span></li>` : "") +
      x.ups.map((u) => `<li class="scope-up"><span>(+) ${esc(u.description || "Upgrade")}</span><span class="scope-amt">${fmtUSD(u.price)}</span></li>`).join("") +
      (x.adjust > 0 ? `<li class="scope-up"><span>(+) Contractor Pricing</span><span class="scope-amt">${fmtUSD(x.adjust)}</span></li>` : ""))
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
              <tr><td class="left">(+) Contractor Pricing</td><td>${fmtUSD(m.adjust)}</td></tr>
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
        <td class="left trade">${esc(x.g.trade)}${x.ups.map((u) => `<div class="snap-sub">– ${esc(u.description || "upgrade")} <span class="snap-up">+${money0(u.price)}</span></div>`).join("")}${x.adjust > 0 ? `<div class="snap-sub">– contractor pricing <span class="snap-up">+${money0(x.adjust)}</span></div>` : ""}</td>
        <td class="center">${x.meas != null && x.uom ? `${esc(x.meas)} ${esc(x.uom)}` : ""}</td>
        <td class="sub">${x.payRCV > 0 ? cell(x.payACV, x) : "—"}</td>
        <td class="sub">${x.payRCV > 0 ? cell(x.payRCV, x) : "—"}</td>
        <td>${cell(x.contracted, x)}</td>
        <td>${x.priced ? cell(x.cost, x) : "—"}</td>
        <td class="${pctCls(x.pct)}">${x.priced ? fmtPct1(x.pct) : "—"}</td>
      </tr>`).join("");
  const snapshotPage = `
    <section class="page">
      <div class="doc-head">
        <p class="doc-eyebrow">SFC Estimate · Price Snapshot</p>
        <h1 class="doc-title sfc-title">${titleOf("SFC Estimate")}</h1>
        ${subline ? `<p class="doc-sub">${subline}</p>` : ""}
      </div>
      <table class="summary sfc-est sfc-payout snap">
        <thead>
          <tr>
            <th class="left" rowspan="2">Trade</th><th class="center" rowspan="2">Quantity</th>
            <th class="group" colspan="2">Ins. Payout Breakdown</th>
            <th rowspan="2">Contracted Amount</th><th rowspan="2">SFC Cost</th><th rowspan="2">% Profit Margin</th>
          </tr>
          <tr><th class="sub">ACV</th><th class="sub">RCV</th></tr>
        </thead>
        <tbody>
          ${snapRows}
          <tr>
            <td class="left trade">OTHER JOB COSTS</td>
            <td></td><td class="sub"></td><td class="sub"></td><td></td>
            <td>${money0(m.other)}</td>
            <td></td>
          </tr>
          <tr class="snap-money">
            <td class="left trade">ACV CREDITS</td>
            <td class="center credit-amt">${m.acvCredits > 0 ? fmtUSD(m.acvCredits) : "—"}</td>
            <td class="sub"></td><td class="sub"></td><td></td><td></td><td></td>
          </tr>
          ${m.marketing > 0 ? `
          <tr class="snap-money">
            <td class="left trade">MARKETING CREDITS<div class="snap-sub">${esc(sfc.marketingCredits.map((mk) => mk.type).join(", "))}</div></td>
            <td></td><td class="sub"></td><td class="sub"></td>
            <td class="neg">(${fmtUSD(m.marketing)})</td>
            <td></td><td></td>
          </tr>` : ""}
        </tbody>
        <tfoot>
          <tr class="sfc-net">
            <td class="left trade">TOTAL${m.upgrades > 0 ? `<div class="snap-sub">Incl. Upgrades <span class="snap-up">+${money0(m.upgrades)}</span></div>` : ""}${m.adjust > 0 ? `<div class="snap-sub">Incl. Contractor Pricing <span class="snap-up">+${money0(m.adjust)}</span></div>` : ""}</td>
            <td></td>
            <td class="sub">${money0(m.claimACV)}</td>
            <td class="sub">${money0(m.claimRCV)}</td>
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
  document.getElementById("sfcBackdrop").addEventListener("click", closeSfcModal);

  // Summary modal controls: download, and close via ✕ / backdrop / Escape.
  document.getElementById("downloadModalBtn").addEventListener("click", () => window.print());
  document.getElementById("closeModalBtn").addEventListener("click", closeSummaryModal);
  document.getElementById("modalBackdrop").addEventListener("click", closeSummaryModal);

  // Discrepancy modal: "Fix Discrepancy" returns to the review table; "Build Anyway" builds as-is.
  document.getElementById("fixDiscBtn").addEventListener("click", () => {
    closeDiscrepancyModal();
    document.getElementById("review").scrollIntoView({ behavior: "smooth", block: "start" });
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
