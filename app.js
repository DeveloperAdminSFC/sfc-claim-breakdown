/* =============================================================================
   Claim Breakdown by Trade — standalone tool (no backend, no database)
   -----------------------------------------------------------------------------
   Flow:
     1. Upload a claim PDF.
     2. The browser calls the Anthropic API DIRECTLY (same prompt + model the OI
        platform backend uses) to extract every line item + a trade guess.
     3. You review/correct the trade on each line.
     4. Build a one-page summary (O&P · Tax · RCV · Depreciation · Non-Recoverable
        Dep · ACV by trade) and Save as PDF.

   Nothing is persisted server-side. The only thing stored is your Anthropic API
   key, in this browser's localStorage, so you don't retype it. Everything else
   lives in the page for the session and is gone on refresh.

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

// --------------------------- Anthropic config ---------------------------- //
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6"; // matches backend/app/routers/estimates.py

// Production backend (Cloud Run) used when no local API key is entered. Its
// /api/estimates/{job}/parse endpoint parses the PDF server-side (no timeout limit,
// unlike Netlify Functions). Fill in the real URL before deploy.
const BACKEND_URL = "https://sfc-operational-intelligence-git-101019263046.us-central1.run.app"; // fill in before deploy

// The extraction prompt. Reuses the OI backend's PARSE_PROMPT, plus a richer summary
// (insurance, deductible) for the header. Trade is NOT classified here — every line
// starts "Not Categorized" and the user assigns trades in the review step.
const PARSE_PROMPT = `Extract every line item from this insurance claim/estimate PDF and return JSON.

The table has many columns. Typical column order from LEFT to RIGHT:
Description | Quantity | Unit Price | Per | Age/Life | Condition | Total O&P | Total Taxes | RC (Replacement Cost) | Depreciation | ACV (Actual Cash Value)

IMPORTANT:
- "RC" is the Replacement Cost (same as RCV). This is the LARGE total cost for the line item.
- The math rule is: RCV - Depreciation = ACV. Use this to verify you are reading the right columns.
- Only extract per line item: Description, Quantity, RC/RCV, Depreciation, ACV.
- Per-line Total O&P and Total Taxes are NOT extracted per line — they belong in the summary section only.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "items": [
    {
      "number": "line item number as string",
      "description": "line item description",
      "quantity": "quantity with unit (e.g. '12.47 SQ', '110.00 LF', '1.00 EA')",
      "rcv": number (RC/RCV column. Use 0.0 if blank or marked 'REVISED'/'PER BID'),
      "depreciation": number (positive, e.g. 502.88. Use 0.0 if none),
      "depreciationType": "recoverable" if shown in parentheses like (123.45), "non-recoverable" if in angle brackets like <123.45>,
      "acv": number (ACV column, positive. Use 0.0 if blank or marked 'REVISED'/'PER BID')
    }
  ],
  "summary": {
    "insurance_company": string or null,
    "claim_number": string or null,
    "date_of_loss": string or null,
    "deductible": number or null,
    "totalRCV": number or null,
    "totalDepreciation": number or null,
    "totalACV": number or null,
    "totalOP": number or null (estimate-wide overhead & profit from the summary/totals section),
    "totalTax": number or null (estimate-wide sales tax from the summary/totals section),
    "totalRecoverableDepreciation": number or null
  }
}

Rules:
- Include EVERY line item, do not skip any.
- Quantity must include the unit.
- All numbers POSITIVE (rcv, depreciation, acv).
- depreciation is 0.0 if none.
- totalOP and totalTax come from the estimate's summary/totals section, NOT per line item.
- For rcv, depreciation, acv on line items: ALWAYS return a number (0.0 if blank/unreadable). Never null.
- For summary fields: null is acceptable if that figure is missing or unreadable.
- VERIFY each line: rcv - depreciation ≈ acv. If it doesn't match, re-read the columns.`;

// ------------------------------- State ----------------------------------- //
// The parsed line items for the current claim. Trade is editable in the review
// table before the summary is built. This is the only source of truth; it is
// never sent anywhere except the one Anthropic parse call.
let state = { items: [], summary: {} };

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

// ------------------------- Anthropic PDF parse --------------------------- //
// Read a File into a base64 string without blowing the call stack on big PDFs.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });
}

// Pull the JSON object out of Claude's text (strip code fences first).
function extractParsed(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The parser did not return JSON. Try again.");
  return JSON.parse(match[0]);
}

// Two ways to reach Claude, depending on deployment:
//   • Local / testing: a key is in the field → call Anthropic directly from the browser.
//   • Deployed: field is blank → POST the PDF to the production Cloud Run backend's
//     /api/estimates/{job}/parse endpoint, which holds the key and parses server-side.
// Both resolve to a parsed { items, summary } object.
async function requestParse(pdf_b64, key, file) {
  if (key) {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 32000,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf_b64 } },
            { type: "text", text: PARSE_PROMPT },
          ],
        }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error("Anthropic API error: " + (data?.error?.message || `${res.status} ${res.statusText}`));
    }
    if (data.stop_reason === "max_tokens") {
      throw new Error("The estimate is too large to parse in one pass (output was truncated). Try splitting the PDF.");
    }
    const text = (data.content || []).map((b) => b.text || "").join("").trim();
    if (!text) throw new Error("The parser returned an empty response. Try again.");
    return extractParsed(text);
  }

  // Backend path — POST the raw PDF as multipart to the Cloud Run parse endpoint.
  // Job number 0 is a harmless placeholder: parse_estimate reads/writes no job data
  // (it has no BigQuery dependency), it only parses the PDF and returns JSON.
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
  const key = document.getElementById("apiKey").value.trim();
  if (file.size > 50_000_000) return setStatus("PDF is over 50MB — too large to parse in one pass.", "error");

  // Base64 is only needed for the local direct-to-Anthropic path; the backend path
  // sends the raw File as multipart.
  let pdf_b64 = null;
  if (key) {
    setStatus(`Reading “${file.name}”…`);
    try {
      pdf_b64 = await fileToBase64(file);
    } catch (e) {
      return setStatus(e.message, "error");
    }
  }

  setStatus(`Parsing “${file.name}”… this usually takes 10–40s.`);
  document.getElementById("pdfBtn").disabled = true;
  try {
    const parsed = await requestParse(pdf_b64, key, file);

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
    if (key) localStorage.setItem("cb_anthropicKey", key);

    renderReview();
    setStatus(
      `Parsed ${items.length} line item${items.length === 1 ? "" : "s"}. ` +
      `All start “Not Categorized” — select lines and assign a trade, then Build summary.`,
      "ok"
    );
  } catch (err) {
    setStatus(
      `${err.message}${/failed to fetch/i.test(err.message) ? " — check your network" + (key ? " and that the API key is valid." : " (or paste an API key to parse directly).") : ""}`,
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

function updateSelCount() {
  const n = document.querySelectorAll("#reviewBody .row-chk:checked").length;
  document.getElementById("selCount").textContent = `${n} selected`;
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

  // Row selection.
  body.querySelectorAll(".row-chk").forEach((chk) =>
    chk.addEventListener("change", updateSelCount)
  );
  const selectAll = document.getElementById("selectAll");
  selectAll.checked = false;

  // Populate the trade select once.
  const bulk = document.getElementById("bulkTradeSelect");
  if (!bulk.options.length) {
    bulk.innerHTML = TRADE_ORDER.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  }
  updateSelCount();

  document.getElementById("review").hidden = false;
  document.getElementById("empty").style.display = "none";
  document.getElementById("doc").hidden = true;
  document.getElementById("downloadBtn").disabled = true;
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

  const metaRows = [
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
  docEl.hidden = false;
  document.getElementById("empty").style.display = "none";
  document.getElementById("downloadBtn").disabled = false;
  document.title = "Claim Breakdown by Trade";
  docEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ------------------------------ Wiring ----------------------------------- //
function init() {
  const savedKey = localStorage.getItem("cb_anthropicKey");
  if (savedKey) document.getElementById("apiKey").value = savedKey;

  document.getElementById("clearKeyBtn").addEventListener("click", () => {
    localStorage.removeItem("cb_anthropicKey");
    document.getElementById("apiKey").value = "";
    setStatus("Saved key forgotten.", "ok");
  });

  document.getElementById("pdfBtn").addEventListener("click", () =>
    document.getElementById("pdfInput").click()
  );
  document.getElementById("pdfInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) parsePdf(file);
    e.target.value = ""; // allow re-selecting the same file
  });

  document.getElementById("buildBtn").addEventListener("click", () => {
    if (!state.items.length) return setStatus("Nothing to build yet — upload a PDF first.", "error");
    renderDoc();
  });

  // Apply the chosen trade to every checked row (printer-style multi-select).
  document.getElementById("applySelectedBtn").addEventListener("click", () => {
    const t = document.getElementById("bulkTradeSelect").value;
    const checked = [...document.querySelectorAll("#reviewBody .row-chk:checked")];
    if (!checked.length) return setStatus("Select one or more rows first (checkboxes on the left).", "error");
    checked.forEach((chk) => {
      const i = Number(chk.dataset.i);
      state.items[i].trade = t;
      const sel = document.querySelector(`.trade-select[data-i="${i}"]`);
      if (sel) sel.value = t;
    });
    setStatus(`Set ${checked.length} line item${checked.length === 1 ? "" : "s"} to ${t}.`, "ok");
  });

  // Select-all header checkbox toggles every row.
  document.getElementById("selectAll").addEventListener("change", (e) => {
    document.querySelectorAll("#reviewBody .row-chk").forEach((chk) => (chk.checked = e.target.checked));
    updateSelCount();
  });

  document.getElementById("downloadBtn").addEventListener("click", () => window.print());

  // Sample — renders the bundled example so you can see the output with no API call.
  document.getElementById("sampleBtn").addEventListener("click", async () => {
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
  });

  // Drag & drop a PDF anywhere on the toolbar.
  const tb = document.getElementById("toolbar");
  ["dragover", "drop"].forEach((evt) => tb.addEventListener(evt, (e) => e.preventDefault()));
  tb.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) parsePdf(file);
  });
}

document.addEventListener("DOMContentLoaded", init);
