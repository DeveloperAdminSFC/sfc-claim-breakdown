/* =============================================================================
   Claim Breakdown by Trade — standalone tool
   -----------------------------------------------------------------------------
   Flow:
     1. Upload a claim PDF.
     2. The PDF is sent to the Cloud Run backend's /api/estimates/{job}/parse
        endpoint, which extracts every line item.
     3. You review/correct the trade on each line.
     4. Build a one-page summary (O&P · Tax · RCV · Depreciation · Non-Recoverable
        Dep · ACV by trade) and Save as PDF.

   Nothing is persisted. Parsed line items live in the page for the session and
   are gone on refresh.

   Math conventions mirror the OI platform:
     • Non-recoverable dep = depreciationType === "non-recoverable" ? depreciation : 0
     • RCV − Depreciation = ACV per line and per trade.
     • O&P / Taxes are NOT tracked per trade — they exist only as estimate-wide
       totals, shown in the summary Total row.
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
let state = { items: [], summary: {}, jobInfo: null };

// ------------------------------ Helpers ---------------------------------- //
const fmtUSD = (n) =>
  (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

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
    return setStatus("That isn't a PDF. Choose a .pdf claim/estimate.", "error");
  }
  if (file.size > 50_000_000) return setStatus("PDF is over 50MB — too large to parse in one pass.", "error");

  setStatus(`Parsing “${file.name}”… this usually takes 10–40s.`);
  document.getElementById("pdfBtn").disabled = true;
  try {
    const parsed = await requestParse(file);

    const items = (parsed.items || []).map((it) => {
      const depreciation = Number(it.depreciation) || 0;
      return {
        number: it.number != null ? String(it.number) : "",
        description: it.description || "",
        quantity: it.quantity || "",
        rcv: Number(it.rcv) || 0,
        depreciation,
        // Seed non-recoverable from the notation Claude read; then it's freely editable.
        nonRecoverableDep: it.depreciationType === "non-recoverable" ? depreciation : 0,
        acv: (Number(it.rcv) || 0) - depreciation, // ACV is always RCV − Depreciation
        trade: "Not Categorized", // every line starts uncategorized
      };
    });
    if (!items.length) throw new Error("No line items found in this PDF.");

    state = { items, summary: parsed.summary || {} };

    renderReview();
    setStatus(
      `Parsed ${items.length} line item${items.length === 1 ? "" : "s"}. ` +
      `All start “Not Categorized” — select lines and assign a trade, then Build summary.`,
      "ok"
    );
  } catch (err) {
    setStatus(
      `${err.message}${/failed to fetch/i.test(err.message) ? " — check your network." : ""}`,
      "error"
    );
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

// Recompute a row's ACV cell live: ACV = RCV − Depreciation.
function refreshAcvCell(i) {
  const it = state.items[i];
  it.acv = (Number(it.rcv) || 0) - (Number(it.depreciation) || 0);
  const cell = document.querySelector(`.acv-cell[data-i="${i}"]`);
  if (cell) cell.textContent = fmtUSD(it.acv);
}

// Recompute "N selected" and the header checkbox state from the live DOM (never
// from a separately tracked count, which could drift).
function updateSelCount() {
  const boxes = document.querySelectorAll("#reviewBody .row-chk");
  const n = document.querySelectorAll("#reviewBody .row-chk:checked").length;
  document.getElementById("selCount").textContent = `${n} selected`;
  const selectAll = document.getElementById("selectAll");
  selectAll.checked = boxes.length > 0 && n === boxes.length;
  selectAll.indeterminate = n > 0 && n < boxes.length;
}

// Toggle the empty-state (big upload button) vs. loaded chrome (compact toolbar).
function setLoadedChrome(loaded) {
  document.getElementById("empty").hidden = loaded;
  document.getElementById("toolbarActions").hidden = !loaded;
}

// Parse a line-number range string ("1-5, 7, 9, 21b") into a Set of line-number
// strings that actually exist among the given items. Comma-separated tokens are
// each either a numeric range "N-M" (expanded to N..M inclusive) or a single
// token matched as an exact string against the item's displayed Line #.
function parseLineRange(str, items) {
  const present = new Set(items.map((it) => String(it.number)));
  const wanted = new Set();
  for (const raw of String(str).split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const m = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
      if (lo > hi) [lo, hi] = [hi, lo];
      for (let n = lo; n <= hi; n++) {
        const s = String(n);
        if (present.has(s)) wanted.add(s);
      }
    } else if (present.has(token)) {
      wanted.add(token);
    }
  }
  return wanted;
}

function renderReview() {
  const body = document.getElementById("reviewBody");
  body.innerHTML = state.items
    .map((it, i) => `
      <tr>
        <td class="ctr sel-col"><input type="checkbox" class="row-chk" data-i="${i}" /></td>
        <td class="num">${esc(it.number)}</td>
        <td class="left desc">${esc(it.description)}</td>
        <td class="left">${esc(it.quantity)}</td>
        <td class="edit-col">${moneyInput("rcv-in", i, it.rcv)}</td>
        <td class="edit-col">${moneyInput("dep-in", i, it.depreciation)}</td>
        <td class="edit-col">${moneyInput("nonrec-in", i, it.nonRecoverableDep)}</td>
        <td class="acv-cell" data-i="${i}">${fmtUSD(it.acv)}</td>
        <td class="left">${tradeSelectHTML(it.trade, `data-i="${i}"`)}</td>
      </tr>`)
    .join("");

  // Per-row trade selects.
  body.querySelectorAll(".trade-select").forEach((sel) =>
    sel.addEventListener("change", (e) => {
      state.items[Number(e.target.dataset.i)].trade = e.target.value;
    })
  );

  // Editable amounts. RCV / Depreciation drive ACV live; Non-Rec is independent.
  body.querySelectorAll(".rcv-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      state.items[i].rcv = Number(e.target.value) || 0;
      refreshAcvCell(i);
    })
  );
  body.querySelectorAll(".dep-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      state.items[i].depreciation = Number(e.target.value) || 0;
      refreshAcvCell(i);
    })
  );
  body.querySelectorAll(".nonrec-in").forEach((el) =>
    el.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      state.items[i].nonRecoverableDep = Math.max(0, Number(e.target.value) || 0);
    })
  );

  // Row selection — plain independent toggles.
  body.querySelectorAll(".row-chk").forEach((chk) =>
    chk.addEventListener("change", updateSelCount)
  );

  // Populate the trade select once.
  const bulk = document.getElementById("bulkTradeSelect");
  if (!bulk.options.length) {
    bulk.innerHTML = TRADE_ORDER.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  }
  updateSelCount();

  document.getElementById("review").hidden = false;
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
    let rcv = 0, dep = 0, nonRecDep = 0, acv = 0;
    for (const it of its) {
      const r = Number(it.rcv) || 0;
      const d = Number(it.depreciation) || 0;
      rcv += r;
      dep += d;
      acv += r - d; // ACV = RCV − Depreciation
      nonRecDep += Number(it.nonRecoverableDep) || 0;
    }
    return {
      trade: t,
      color: TRADE_COLORS[t] || "#94a3b8",
      items: [...its].sort((x, y) => compareLineNumbers(x.number, y.number)),
      rcv, dep, nonRecDep, acv,
    };
  });
}

function renderDoc() {
  const items = state.items;
  const md = state.summary || {};
  const includeDetail = document.getElementById("detailToggle").checked;
  const groups = groupByTrade(items);

  const totals = groups.reduce(
    (a, g) => { a.rcv += g.rcv; a.dep += g.dep; a.nonRecDep += g.nonRecDep; a.acv += g.acv; return a; },
    { rcv: 0, dep: 0, nonRecDep: 0, acv: 0 }
  );
  const totalOP = md.totalOP != null ? Number(md.totalOP) : null;
  const totalTax = md.totalTax != null ? Number(md.totalTax) : null;

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

  // ---------- PAGE 1: one-page trade summary ----------
  // O&P and Taxes are estimate-wide only: per-trade cells show "—", the Total
  // row carries the estimate totals.
  const dash = '<span class="dash">—</span>';
  const summaryRows = groups
    .map(
      (g) => `
      <tr>
        <td class="left"><span class="trade-cell"><span class="trade-swatch" style="background:${g.color}"></span>${esc(g.trade)}</span></td>
        <td>${dash}</td>
        <td>${dash}</td>
        <td>${fmtUSD(g.rcv)}</td>
        <td>${fmtUSD(g.dep)}</td>
        <td>${fmtUSD(g.nonRecDep)}</td>
        <td>${fmtUSD(g.acv)}</td>
      </tr>`
    )
    .join("");

  const page1 = `
    <section class="page">
      <div class="doc-head">
        <p class="doc-eyebrow">Insurance Claim · Trade Breakdown</p>
        <h1 class="doc-title">Claim Summary by Trade</h1>
        <p class="doc-sub">${esc(md.insurance_company || "")}${md.insurance_company && md.date_of_loss ? " · " : ""}${md.date_of_loss ? "Loss dated " + esc(md.date_of_loss) : ""}</p>
      </div>

      <div class="meta-grid">
        ${metaRows.map(([k, v]) => `<div class="meta-item"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}
      </div>

      <p class="section-label">Summary by Trade</p>
      <table class="summary">
        <thead><tr>
          <th class="left">Trade</th><th>O&amp;P</th><th>Taxes</th>
          <th>RCV</th><th>Depreciation</th><th>Non-Rec. Dep.</th><th>ACV</th>
        </tr></thead>
        <tbody>${summaryRows}</tbody>
        <tfoot><tr>
          <td class="left">Total</td>
          <td>${totalOP != null ? fmtUSD(totalOP) : dash}</td>
          <td>${totalTax != null ? fmtUSD(totalTax) : dash}</td>
          <td>${fmtUSD(totals.rcv)}</td>
          <td>${fmtUSD(totals.dep)}</td>
          <td>${fmtUSD(totals.nonRecDep)}</td>
          <td>${fmtUSD(totals.acv)}</td>
        </tr></tfoot>
      </table>

      <p class="footnote">
        <strong>RCV − Depreciation = ACV.</strong> O&amp;P and Taxes are estimate-wide (RCV already
        includes them) and are not split per trade, so per-trade cells show “—” and the estimate totals
        appear in the Total row. Non-Recoverable Depreciation is the portion insurance will not reimburse
        and is a subset of Depreciation.
      </p>
    </section>`;

  // ---------- Optional detail pages: one per trade ----------
  let detailPages = "";
  if (includeDetail) {
    detailPages = groups
      .map((g) => {
        const rows = g.items
          .map((it) => {
            const nrAmt = Number(it.nonRecoverableDep) || 0;
            const nr = nrAmt > 0 ? '<span class="nr-tag">NON-REC</span>' : "";
            return `
            <tr>
              <td class="num">${esc(it.number)}</td>
              <td class="left desc">${esc(it.description)}${nr}</td>
              <td class="left">${esc(it.quantity)}</td>
              <td>${fmtUSD(it.rcv)}</td>
              <td>${fmtUSD(it.depreciation)}</td>
              <td>${nrAmt > 0 ? fmtUSD(nrAmt) : dash}</td>
              <td>${fmtUSD((Number(it.rcv) || 0) - (Number(it.depreciation) || 0))}</td>
            </tr>`;
          })
          .join("");
        return `
        <section class="page">
          <div class="trade-page-head">
            <div class="trade-page-title"><span class="bar" style="background:${g.color}"></span><h2>${esc(g.trade)}</h2></div>
            <div class="trade-page-totals">
              <div class="tpt"><div class="k">RCV</div><div class="v">${fmtUSD(g.rcv)}</div></div>
              <div class="tpt"><div class="k">Depreciation</div><div class="v">${fmtUSD(g.dep)}</div></div>
              <div class="tpt"><div class="k">ACV</div><div class="v">${fmtUSD(g.acv)}</div></div>
            </div>
          </div>
          <table class="lines">
            <thead><tr>
              <th class="left">Line&nbsp;#</th><th class="left">Description</th><th class="left">Quantity</th>
              <th>RCV</th><th>Depreciation</th><th>Non-Rec. Dep.</th><th>ACV</th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr>
              <td class="left" colspan="3">${esc(g.trade)} total (${g.items.length} line${g.items.length === 1 ? "" : "s"})</td>
              <td>${fmtUSD(g.rcv)}</td><td>${fmtUSD(g.dep)}</td><td>${fmtUSD(g.nonRecDep)}</td><td>${fmtUSD(g.acv)}</td>
            </tr></tfoot>
          </table>
        </section>`;
      })
      .join("");
  }

  const docEl = document.getElementById("doc");
  docEl.innerHTML = page1 + detailPages;
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
      const depreciation = Number(it.depreciation) || 0;
      const rcv = Number(it.rcv) || 0;
      return {
        number: it.number != null ? String(it.number) : "",
        description: it.description || "",
        quantity: it.quantity || "",
        rcv,
        depreciation,
        nonRecoverableDep: it.depreciationType === "non-recoverable" ? depreciation : 0,
        acv: rcv - depreciation,
        trade: "Not Categorized", // start uncategorized, like a real parse
      };
    });
    const m = group.metadata || {};
    const sumOP = src.reduce((s, it) => s + (Number(it.op) || 0), 0);
    const sumTax = src.reduce((s, it) => s + (Number(it.tax) || 0), 0);
    state = {
      items,
      summary: {
        insurance_company: m.insurance_company,
        claim_number: m.claim_number,
        date_of_loss: m.claim_date || m.date_of_loss,
        deductible: m.deductible,
        totalOP: m.total_op != null ? m.total_op : (sumOP || null),
        totalTax: m.total_tax != null ? m.total_tax : (sumTax || null),
      },
    };
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

  // Both upload affordances (big empty-state button + compact toolbar button) open
  // the same hidden file picker.
  const openPicker = () => document.getElementById("pdfInput").click();
  document.getElementById("pdfBtn").addEventListener("click", openPicker);
  document.getElementById("emptyUploadBtn").addEventListener("click", openPicker);
  document.getElementById("pdfInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) parsePdf(file);
    e.target.value = ""; // allow re-selecting the same file
  });

  document.getElementById("buildBtn").addEventListener("click", () => {
    if (!state.items.length) return setStatus("Nothing to build yet — upload a PDF first.", "error");
    renderDoc();
  });

  // Apply the chosen trade. A typed line-number range takes priority; otherwise
  // fall back to whatever checkboxes are manually checked.
  document.getElementById("applySelectedBtn").addEventListener("click", () => {
    const t = document.getElementById("bulkTradeSelect").value;
    const rangeEl = document.getElementById("rangeInput");
    const rangeStr = rangeEl.value.trim();

    let targetIndexes;
    if (rangeStr) {
      const wanted = parseLineRange(rangeStr, state.items);
      targetIndexes = state.items.reduce((acc, it, i) => {
        if (wanted.has(String(it.number))) acc.push(i);
        return acc;
      }, []);
      if (!targetIndexes.length) return setStatus("No line items match that range.", "error");
      // Reflect the range as the selection: check exactly the matched rows.
      document.querySelectorAll("#reviewBody .row-chk").forEach((c) => (c.checked = false));
    } else {
      targetIndexes = [...document.querySelectorAll("#reviewBody .row-chk:checked")].map((c) => Number(c.dataset.i));
      if (!targetIndexes.length) {
        return setStatus("Type a line-number range (e.g. 1-5, 7, 9) or check some rows first.", "error");
      }
    }

    targetIndexes.forEach((i) => {
      state.items[i].trade = t;
      const sel = document.querySelector(`.trade-select[data-i="${i}"]`);
      if (sel) sel.value = t;
      if (rangeStr) {
        const chk = document.querySelector(`.row-chk[data-i="${i}"]`);
        if (chk) chk.checked = true; // visual confirmation of the matched rows
      }
    });

    updateSelCount();
    if (rangeStr) rangeEl.value = ""; // clear for the next entry
    setStatus(`Set ${targetIndexes.length} line item${targetIndexes.length === 1 ? "" : "s"} to ${t}.`, "ok");
  });

  // Select-all header checkbox toggles every row.
  document.getElementById("selectAll").addEventListener("change", (e) => {
    document.querySelectorAll("#reviewBody .row-chk").forEach((chk) => (chk.checked = e.target.checked));
    updateSelCount();
  });

  // Summary modal controls: download, and close via ✕ / backdrop / Escape.
  document.getElementById("downloadModalBtn").addEventListener("click", () => window.print());
  document.getElementById("closeModalBtn").addEventListener("click", closeSummaryModal);
  document.getElementById("modalBackdrop").addEventListener("click", closeSummaryModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("summaryModal").hidden) closeSummaryModal();
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
