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
  "PERSONAL PROPERTY": "#d946ef", // fuchsia — distinct from the 11 above
  "Not Trade Related": "#94a3b8",
  "Not Categorized": "#cbd5e1",
};

// --------------------------- Backend config ------------------------------ //
// Production backend (Cloud Run). Its /api/estimates/{job}/parse endpoint parses the
// PDF server-side and returns { items, summary, validation }.
const BACKEND_URL = "https://sfc-operational-intelligence-git-101019263046.us-central1.run.app";

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
        recoverableDep,
        nonRecoverableDep,
        // Struck-through in the source = paid when incurred (carved out of ACV). The parser
        // sends the carve-out AMOUNT (the struck line's RCV); 0 for normal lines. Editable.
        paidWhenIncurred: Number(it.paidWhenIncurred) || 0,
        acv: rcv - (Number(it.paidWhenIncurred) || 0) - recoverableDep - nonRecoverableDep,
        trade: "Not Categorized", // every line starts uncategorized
      };
    });
    if (!items.length) throw new Error("No line items found in this PDF.");
    assignDisplayNumbers(items); // stamp displayNumber (C1… for later sections)

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

// Recompute a row's ACV cell live. ACV is the one computed cell and always:
//   ACV = RCV − Paid When Incurred − Recoverable Dep − Non-Recoverable Dep.
// All four inputs feed it, so editing any of them (or moving a value between buckets)
// just follows this single formula — no special cases.
function refreshAcvCell(i) {
  const it = state.items[i];
  it.acv =
    (Number(it.rcv) || 0) -
    (Number(it.paidWhenIncurred) || 0) -
    (Number(it.recoverableDep) || 0) -
    (Number(it.nonRecoverableDep) || 0);
  const cell = document.querySelector(`.acv-cell[data-i="${i}"]`);
  if (cell) cell.textContent = fmtUSD(it.acv);
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
  const acvLineItems = sumRCV - sumPWI - sumRecov - sumNonRec;

  const defs = [
    { label: "RCV", lineItems: sumRCV, claim: s.totalRCV },
    { label: "Recoverable Dep.", lineItems: sumRecov, claim: s.totalRecoverableDepreciation },
    { label: "Non-Recoverable Dep.", lineItems: sumNonRec, claim: s.totalNonRecoverableDepreciation },
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
      <tr data-i="${i}">
        <td class="num">${esc(it.displayNumber)}</td>
        <td class="left desc">${esc(it.description)}</td>
        <td class="left">${esc(it.quantity)}</td>
        <td class="edit-col">${moneyInput("rcv-in", i, it.rcv)}</td>
        <td class="edit-col">${moneyInput("pwi-in", i, it.paidWhenIncurred)}</td>
        <td class="edit-col">${moneyInput("rec-in", i, it.recoverableDep)}</td>
        <td class="edit-col">${moneyInput("nonrec-in", i, it.nonRecoverableDep)}</td>
        <td class="acv-cell" data-i="${i}">${fmtUSD(it.acv)}</td>
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
    let rcv = 0, recDep = 0, nonRecDep = 0, pwi = 0, acv = 0;
    for (const it of its) {
      const r = Number(it.rcv) || 0;
      const p = Number(it.paidWhenIncurred) || 0;
      const rec = Number(it.recoverableDep) || 0;
      const nr = Number(it.nonRecoverableDep) || 0;
      rcv += r;
      recDep += rec;
      nonRecDep += nr;
      pwi += p;
      acv += r - p - rec - nr; // each line's ACV already nets PWI — same formula everywhere
    }
    return {
      trade: t,
      color: TRADE_COLORS[t] || "#94a3b8",
      items: [...its].sort((x, y) => compareLineNumbers(x.displayNumber, y.displayNumber)),
      rcv, recDep, nonRecDep, pwi, acv,
    };
  });
}

// One "Summary by Trade" table: trade rows + a total row. O&P/Taxes are estimate-wide,
// so per-trade cells always show "—"; they only carry a value on the row where op/tax are
// passed (the single-structure Total, or the multi-structure Claim Total). showRows:false
// omits the trade rows — used for the compact Claim Total strip (header + total only).
function summaryTableHTML(groups, { op = null, tax = null, totalLabel = "Total", showRows = true } = {}) {
  const dash = dashHTML;
  const t = groups.reduce(
    (a, g) => {
      a.rcv += g.rcv; a.recDep += g.recDep; a.nonRecDep += g.nonRecDep; a.pwi += g.pwi; a.acv += g.acv;
      return a;
    },
    { rcv: 0, recDep: 0, nonRecDep: 0, pwi: 0, acv: 0 }
  );
  const rows = !showRows ? "" : groups
    .map(
      (g) => `
      <tr>
        <td class="left"><span class="trade-cell"><span class="trade-swatch" style="background:${g.color}"></span>${esc(g.trade)}</span></td>
        <td>${dash}</td>
        <td>${dash}</td>
        <td>${fmtUSD(g.rcv)}</td>
        <td>${g.pwi > 0 ? fmtUSD(g.pwi) : dash}</td>
        <td>${fmtUSD(g.recDep)}</td>
        <td>${fmtUSD(g.nonRecDep)}</td>
        <td>${fmtUSD(g.acv)}</td>
      </tr>`
    )
    .join("");
  return `
      <table class="summary">
        <thead><tr>
          <th class="left">Trade</th><th>O&amp;P</th><th>Taxes</th>
          <th>RCV</th><th>Paid When Incurred</th><th>Recoverable Dep.</th><th>Non-Rec. Dep.</th><th>ACV</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td class="left">${esc(totalLabel)}</td>
          <td>${op != null ? fmtUSD(op) : dash}</td>
          <td>${tax != null ? fmtUSD(tax) : dash}</td>
          <td>${fmtUSD(t.rcv)}</td>
          <td>${t.pwi > 0 ? fmtUSD(t.pwi) : dash}</td>
          <td>${fmtUSD(t.recDep)}</td>
          <td>${fmtUSD(t.nonRecDep)}</td>
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
  const rows = pageItems
    .map((it) => {
      const recAmt = Number(it.recoverableDep) || 0;
      const nrAmt = Number(it.nonRecoverableDep) || 0;
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
              <td>${fmtUSD(rcv - pwiAmt - recAmt - nrAmt)}</td>
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
              <td>${fmtUSD(g.rcv)}</td><td>${g.pwi > 0 ? fmtUSD(g.pwi) : dash}</td><td>${fmtUSD(g.recDep)}</td><td>${fmtUSD(g.nonRecDep)}</td><td>${fmtUSD(g.acv)}</td>
            </tr></tfoot>`;
  return `
        <section class="page">
          <div class="trade-page-head">
            <div class="trade-page-title"><span class="bar" style="background:${g.color}"></span><h2>${esc(g.trade)}${cont ? ' <span class="cont-tag">(cont.)</span>' : ""}</h2></div>${totals}
          </div>
          <table class="lines">
            <thead><tr>
              <th class="left">Line&nbsp;#</th><th class="left">Description</th><th class="left">Quantity</th>
              <th>RCV</th><th>Paid When Incurred</th><th>Recoverable Dep.</th><th>Non-Rec. Dep.</th><th>ACV</th>
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
  const metaRows = [
    ["Job #", job && job.job_number != null ? String(job.job_number) : "—"],
    ["Client", (job && job.contact_name) || "—"],
    ["Insurance", md.insurance_company || "—"],
    ["Claim #", md.claim_number || "—"],
    ["Date of Loss", md.date_of_loss || "—"],
    ["Deductible", md.deductible != null ? fmtUSD(md.deductible) : "—"],
    ["Line Items", String(items.length)],
    ["Printed", new Date().toLocaleDateString("en-US")],
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
        ${metaRows.map(([k, v]) => `<div class="meta-item"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}
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
        recoverableDep,
        nonRecoverableDep,
        paidWhenIncurred,
        acv: rcv - paidWhenIncurred - recoverableDep - nonRecoverableDep,
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
