/* =============================================================================
   Claim Breakdown by Trade — standalone app
   -----------------------------------------------------------------------------
   Mirrors the claim-breakdown logic from the OI platform:
     • groupByTrade()  → estimate-print/page.tsx
     • non-recoverable dep = depreciationType === "non-recoverable" ? depreciation : 0
     • RCV − Depreciation = ACV holds per line and per trade

   O&P and Taxes columns are CONDITIONAL: they appear only if the loaded line
   items actually carry per-line O&P / Tax values (see OP_KEYS / TAX_KEYS below).
   If no line item has them, the columns are omitted entirely — no empty cells.
   The two columns are independent: an estimate can have per-line tax but no O&P.

   Note: the OI parser currently discards the per-line O&P/Tax columns, so data
   from /api/estimates won't include them unless the extractor is updated to emit
   an `op` and/or `tax` field per line item.
   ========================================================================== */

// Trade display order — mirrors TRADE_OPTIONS in frontend/src/lib/trades.tsx
const TRADE_ORDER = [
  "Not Categorized",
  "Not Trade Related",
  "ROOF",
  "GUTTERS",
  "SIDING",
  "WINDOWS",
  "SOLAR",
  "PAINT",
  "FENCE",
  "GARAGE",
  "MISC",
];

// Accent colors — mirror TRADE_BADGE / TRADE_CHART_COLORS in the OI platform.
const TRADE_COLORS = {
  "Not Categorized": "#cbd5e1",
  "Not Trade Related": "#94a3b8",
  ROOF: "#3b82f6",
  GUTTERS: "#10b981",
  SIDING: "#f59e0b",
  WINDOWS: "#8b5cf6",
  SOLAR: "#06b6d4",
  PAINT: "#f43f5e",
  FENCE: "#f97316",
  GARAGE: "#6366f1",
  MISC: "#64748b",
};

// Per-line O&P / Tax field names the app will recognize, in priority order.
const OP_KEYS = ["op", "o_and_p", "oandp", "overhead_profit", "overheadProfit", "total_op"];
const TAX_KEYS = ["tax", "taxes", "sales_tax", "salesTax", "total_tax"];

const fmtUSD = (n) =>
  (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

function readNum(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== "" && !isNaN(Number(v))) return Number(v);
  }
  return null; // not present
}
const lineOP = (it) => readNum(it, OP_KEYS);
const lineTax = (it) => readNum(it, TAX_KEYS);

// Does any line carry per-line O&P / Tax? Each column is decided independently.
function detectColumns(items) {
  let hasOP = false, hasTax = false;
  for (const it of items) {
    if (!hasOP && lineOP(it) != null) hasOP = true;
    if (!hasTax && lineTax(it) != null) hasTax = true;
    if (hasOP && hasTax) break;
  }
  return { hasOP, hasTax };
}

// --- Natural sort for line numbers ("1", "1a", "21b") — from estimate-print/page.tsx
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
  const ta = tokenize(a);
  const tb = tokenize(b);
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i];
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else if (typeof x === "string" && typeof y === "string") {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      return typeof x === "number" ? -1 : 1;
    }
  }
  return ta.length - tb.length;
}

// --- Core grouping. One pass per trade computing the summary figures. ---
function groupByTrade(items) {
  const byTrade = new Map();
  for (const it of items) {
    const t = it.trade || "Not Categorized";
    if (!byTrade.has(t)) byTrade.set(t, []);
    byTrade.get(t).push(it);
  }

  // Ordered trades first (TRADE_ORDER), then any unrecognized trade values.
  const ordered = TRADE_ORDER.filter((t) => byTrade.has(t));
  const extras = [...byTrade.keys()].filter((t) => !TRADE_ORDER.includes(t)).sort();
  const tradeKeys = [...ordered, ...extras];

  return tradeKeys.map((t) => {
    const its = byTrade.get(t);
    let rcv = 0, dep = 0, nonRecDep = 0, acv = 0, op = 0, tax = 0;
    for (const it of its) {
      const r = Number(it.rcv) || 0;
      const d = Number(it.depreciation) || 0;
      const a = Number(it.acv) || 0;
      rcv += r;
      dep += d;
      acv += a;
      if (it.depreciationType === "non-recoverable") nonRecDep += d;
      op += lineOP(it) || 0;
      tax += lineTax(it) || 0;
    }
    return {
      trade: t,
      color: TRADE_COLORS[t] || "#94a3b8",
      items: [...its].sort((x, y) => compareLineNumbers(x.number, y.number)),
      rcv, dep, nonRecDep, acv, op, tax,
    };
  });
}

// --- Normalize whatever JSON shape was provided into { items, metadata }. -----
function normalizeInput(raw, estimateType) {
  if (!raw) throw new Error("No data provided.");
  let obj = raw;
  if (typeof raw === "string") obj = JSON.parse(raw);

  if (obj && (obj.initial || obj.final)) {
    const group = estimateType === "initial" ? obj.initial : obj.final;
    if (!group || !Array.isArray(group.items) || group.items.length === 0) {
      throw new Error(`No ${estimateType} estimate line items found in this data.`);
    }
    return { items: group.items, metadata: group.metadata || {} };
  }
  if (obj && Array.isArray(obj.items)) {
    return { items: obj.items, metadata: obj.metadata || {} };
  }
  if (Array.isArray(obj)) {
    return { items: obj, metadata: {} };
  }
  throw new Error("Unrecognized JSON shape. Expect an estimates response, a { items, metadata } object, or an items array.");
}

// ============================== RENDERING ================================= //
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const money = (v) => (v == null ? '<span class="dash">—</span>' : fmtUSD(v));

function renderDoc({ items, metadata, estimateType, jobLabel }) {
  const groups = groupByTrade(items);
  const { hasOP, hasTax } = detectColumns(items);

  const totals = groups.reduce(
    (acc, g) => {
      acc.rcv += g.rcv; acc.dep += g.dep; acc.nonRecDep += g.nonRecDep;
      acc.acv += g.acv; acc.op += g.op; acc.tax += g.tax;
      return acc;
    },
    { rcv: 0, dep: 0, nonRecDep: 0, acv: 0, op: 0, tax: 0 }
  );

  const md = metadata || {};
  const typeLabel = estimateType === "initial" ? "Initial" : "Final";

  const metaRows = [
    ["Job #", jobLabel || "—"],
    ["Estimate Type", typeLabel],
    ["Insurance", md.insurance_company || "—"],
    ["Date of Loss", md.claim_date || "—"],
    ["Deductible", md.deductible != null ? fmtUSD(md.deductible) : "—"],
    ["Printed", new Date().toLocaleDateString("en-US")],
  ];

  // ---------- PAGE 1: Trade summary ----------
  const sumHead =
    `<th class="left">Trade</th>` +
    (hasOP ? `<th>O&amp;P</th>` : ``) +
    (hasTax ? `<th>Taxes</th>` : ``) +
    `<th>RCV</th><th>Depreciation</th><th>Non-Rec. Dep.</th><th>ACV</th>`;

  const summaryRows = groups
    .map(
      (g) => `
      <tr>
        <td class="left">
          <span class="trade-cell">
            <span class="trade-swatch" style="background:${g.color}"></span>${esc(g.trade)}
          </span>
        </td>
        ${hasOP ? `<td>${fmtUSD(g.op)}</td>` : ``}
        ${hasTax ? `<td>${fmtUSD(g.tax)}</td>` : ``}
        <td>${fmtUSD(g.rcv)}</td>
        <td>${fmtUSD(g.dep)}</td>
        <td>${fmtUSD(g.nonRecDep)}</td>
        <td>${fmtUSD(g.acv)}</td>
      </tr>`
    )
    .join("");

  const sumFoot =
    `<td class="left">Total</td>` +
    (hasOP ? `<td>${fmtUSD(totals.op)}</td>` : ``) +
    (hasTax ? `<td>${fmtUSD(totals.tax)}</td>` : ``) +
    `<td>${fmtUSD(totals.rcv)}</td><td>${fmtUSD(totals.dep)}</td>` +
    `<td>${fmtUSD(totals.nonRecDep)}</td><td>${fmtUSD(totals.acv)}</td>`;

  const opTaxNote =
    hasOP || hasTax
      ? `${hasOP && hasTax ? "O&amp;P and Taxes are" : hasOP ? "O&amp;P is" : "Taxes are"} the per-line amount${
          hasOP && hasTax ? "s" : ""
        } carried on the estimate; RCV already includes ${hasOP && hasTax ? "them" : "it"}. `
      : ``;

  const page1 = `
    <section class="page">
      <div class="doc-head">
        <p class="doc-eyebrow">Insurance Claim · Trade Breakdown</p>
        <h1 class="doc-title">${esc(jobLabel ? `Job ${jobLabel}` : "Claim Summary")} — ${typeLabel} Estimate</h1>
        <p class="doc-sub">${esc(md.insurance_company || "")}${md.insurance_company && md.claim_date ? " · " : ""}${md.claim_date ? "Loss dated " + esc(md.claim_date) : ""}</p>
      </div>

      <div class="meta-grid">
        ${metaRows.map(([k, v]) => `<div class="meta-item"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}
      </div>

      <p class="section-label">Summary by Trade</p>
      <table class="summary">
        <thead><tr>${sumHead}</tr></thead>
        <tbody>${summaryRows}</tbody>
        <tfoot><tr>${sumFoot}</tr></tfoot>
      </table>

      <p class="footnote">
        <strong>RCV − Depreciation = ACV.</strong> ${opTaxNote}Non-Recoverable Depreciation is
        the portion insurance will not reimburse and is a subset of Depreciation.
      </p>
    </section>`;

  // ---------- PAGES 2+: one page per trade ----------
  const lineHead =
    `<th class="left">Line&nbsp;#</th><th class="left">Description</th><th class="left">Quantity</th>` +
    (hasOP ? `<th>O&amp;P</th>` : ``) +
    (hasTax ? `<th>Taxes</th>` : ``) +
    `<th>RCV</th><th>Depreciation</th><th>Non-Rec. Dep.</th><th>ACV</th>`;

  const tradePages = groups
    .map((g) => {
      const rows = g.items
        .map((it) => {
          const nb = it.is_billable === false ? '<span class="nb-tag">NON-BILL</span>' : "";
          const nr = it.depreciationType === "non-recoverable" ? '<span class="nr-tag">NON-REC</span>' : "";
          return `
          <tr>
            <td class="num">${esc(it.number)}</td>
            <td class="left desc">${esc(it.description)}${nb}${nr}</td>
            <td class="left">${esc(it.quantity ?? "")}</td>
            ${hasOP ? `<td>${money(lineOP(it))}</td>` : ``}
            ${hasTax ? `<td>${money(lineTax(it))}</td>` : ``}
            <td>${fmtUSD(it.rcv)}</td>
            <td>${fmtUSD(it.depreciation)}</td>
            <td>${it.depreciationType === "non-recoverable" ? fmtUSD(it.depreciation) : '<span class="dash">—</span>'}</td>
            <td>${fmtUSD(it.acv)}</td>
          </tr>`;
        })
        .join("");

      const foot =
        `<td class="left" colspan="3">${esc(g.trade)} total (${g.items.length} line${g.items.length === 1 ? "" : "s"})</td>` +
        (hasOP ? `<td>${fmtUSD(g.op)}</td>` : ``) +
        (hasTax ? `<td>${fmtUSD(g.tax)}</td>` : ``) +
        `<td>${fmtUSD(g.rcv)}</td><td>${fmtUSD(g.dep)}</td>` +
        `<td>${fmtUSD(g.nonRecDep)}</td><td>${fmtUSD(g.acv)}</td>`;

      return `
      <section class="page">
        <div class="trade-page-head">
          <div class="trade-page-title">
            <span class="bar" style="background:${g.color}"></span>
            <h2>${esc(g.trade)}</h2>
          </div>
          <div class="trade-page-totals">
            <div class="tpt"><div class="k">RCV</div><div class="v">${fmtUSD(g.rcv)}</div></div>
            <div class="tpt"><div class="k">Depreciation</div><div class="v">${fmtUSD(g.dep)}</div></div>
            <div class="tpt"><div class="k">ACV</div><div class="v">${fmtUSD(g.acv)}</div></div>
          </div>
        </div>

        <table class="lines">
          <thead><tr>${lineHead}</tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>${foot}</tr></tfoot>
        </table>
      </section>`;
    })
    .join("");

  const docEl = document.getElementById("doc");
  docEl.innerHTML = page1 + tradePages;
  docEl.hidden = false;
  document.getElementById("empty").style.display = "none";
  document.getElementById("printBtn").disabled = false;
  document.title = `Claim Breakdown${jobLabel ? " — Job " + jobLabel : ""} (${typeLabel})`;
}

// ============================== I/O + WIRING ============================== //
function setStatus(msg, kind) {
  const el = document.getElementById("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

function renderFromRaw(raw, estimateType, jobLabel) {
  try {
    const { items, metadata } = normalizeInput(raw, estimateType);
    renderDoc({ items, metadata, estimateType, jobLabel });
    const { hasOP, hasTax } = detectColumns(items);
    const cols = [hasOP && "O&P", hasTax && "Taxes"].filter(Boolean);
    const note = cols.length ? ` Per-line ${cols.join(" & ")} detected.` : " No per-line O&P/Tax on this estimate — those columns omitted.";
    setStatus(`Rendered ${items.length} line item${items.length === 1 ? "" : "s"}.${note}`, "ok");
  } catch (err) {
    setStatus(err.message || String(err), "error");
  }
}

async function fetchByJob() {
  const job = document.getElementById("jobNumber").value.trim();
  const base = document.getElementById("apiBase").value.trim().replace(/\/+$/, "");
  const estimateType = document.getElementById("estimateType").value;
  if (!job) return setStatus("Enter a Job # first.", "error");
  if (!base) return setStatus("Enter your API base URL (where the FastAPI backend is reachable).", "error");

  const url = `${base}/api/estimates/${encodeURIComponent(job)}`;
  setStatus(`Loading ${url} …`);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Request failed (${res.status} ${res.statusText}).`);
    const data = await res.json();
    localStorage.setItem("cb_apiBase", base);
    renderFromRaw(data, estimateType, job);
  } catch (err) {
    setStatus(
      `${err.message} — if this is a CORS or network error, confirm the backend allows this origin, or paste the JSON below instead.`,
      "error"
    );
  }
}

// Upload a claim PDF to the FastAPI backend's AI parser and render the result.
// Contract (backend/app/routers/estimates.py):
//   POST {base}/api/estimates/{job_number}/parse?estimate_type=initial|final
//   multipart body, field "file", content-type application/pdf.
// The parse endpoint does NOT persist to BigQuery, so any job_number works —
// a blank Job # falls back to 0 for this "just look at it" use.
async function parsePdf(file) {
  if (!file) return;
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    return setStatus("That file isn't a PDF. Use a .json file for the other buttons.", "error");
  }
  const base = document.getElementById("apiBase").value.trim().replace(/\/+$/, "");
  const estimateType = document.getElementById("estimateType").value;
  const jobInput = document.getElementById("jobNumber").value.trim();
  const job = jobInput || "0"; // parse doesn't persist; dummy job # is fine
  if (!base) {
    return setStatus("Enter your API base URL (where the FastAPI backend is reachable) before uploading a PDF.", "error");
  }

  const url = `${base}/api/estimates/${encodeURIComponent(job)}/parse?estimate_type=${encodeURIComponent(estimateType)}`;
  const form = new FormData();
  form.append("file", file, file.name);

  setStatus(`Parsing “${file.name}” with the AI extractor… this usually takes 10–30s.`);
  try {
    const res = await fetch(url, { method: "POST", body: form, headers: { Accept: "application/json" } });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try { const e = await res.json(); if (e && e.detail) detail = e.detail; } catch {}
      throw new Error(`Parse failed (${detail}).`);
    }
    const data = await res.json(); // { items, summary, validation }
    localStorage.setItem("cb_apiBase", base);

    // Map the parse response into the { items, metadata } shape the renderer wants.
    const s = data.summary || {};
    const shaped = {
      items: data.items || [],
      metadata: {
        deductible: s.deductible,
        total_op: s.totalOP,
        total_tax: s.totalTax,
      },
    };
    renderFromRaw(shaped, estimateType, jobInput);

    // Surface the backend's RCV/depreciation reconciliation so mis-reads are visible.
    const v = data.validation;
    if (v) {
      const parts = [];
      if (v.summaryRCVTotal != null) {
        parts.push(`RCV ${v.rcvMatch ? "✓ matches" : `⚠ off by ${fmtUSD(v.difference)}`} summary`);
      }
      if (v.summaryDepreciationTotal != null) {
        parts.push(`Depreciation ${v.depreciationMatch ? "✓" : `⚠ off by ${fmtUSD(v.depreciationDifference)}`}`);
      }
      if (parts.length) {
        setStatus(`Parsed ${shaped.items.length} line item${shaped.items.length === 1 ? "" : "s"}. ${parts.join(" · ")}.`,
          v.rcvMatch === false || v.depreciationMatch === false ? "" : "ok");
      }
    }
  } catch (err) {
    setStatus(
      `${err.message} — if this is a CORS/network error, confirm the backend allows this origin (${location.origin}) and the POST/parse route.`,
      "error"
    );
  }
}

function init() {
  const savedBase = localStorage.getItem("cb_apiBase");
  if (savedBase) document.getElementById("apiBase").value = savedBase;

  document.getElementById("fetchBtn").addEventListener("click", fetchByJob);
  document.getElementById("jobNumber").addEventListener("keydown", (e) => {
    if (e.key === "Enter") fetchByJob();
  });

  document.getElementById("parseBtn").addEventListener("click", () => {
    const txt = document.getElementById("jsonInput").value.trim();
    const estimateType = document.getElementById("estimateType").value;
    const job = document.getElementById("jobNumber").value.trim();
    if (!txt) return setStatus("Paste some JSON first.", "error");
    renderFromRaw(txt, estimateType, job);
  });

  document.getElementById("pdfBtn").addEventListener("click", () =>
    document.getElementById("pdfInput").click()
  );
  document.getElementById("pdfInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) parsePdf(file);
    e.target.value = ""; // allow re-selecting the same file
  });

  document.getElementById("fileBtn").addEventListener("click", () =>
    document.getElementById("fileInput").click()
  );
  document.getElementById("fileInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById("jsonInput").value = reader.result;
      const estimateType = document.getElementById("estimateType").value;
      const job = document.getElementById("jobNumber").value.trim();
      renderFromRaw(reader.result, estimateType, job);
    };
    reader.onerror = () => setStatus("Could not read that file.", "error");
    reader.readAsText(file);
  });

  document.getElementById("sampleBtn").addEventListener("click", async () => {
    setStatus("Loading sample…");
    try {
      const res = await fetch("sample-data.json");
      const data = await res.json();
      document.getElementById("jobNumber").value = "1234";
      renderFromRaw(data, document.getElementById("estimateType").value, "1234");
    } catch {
      setStatus("Could not load sample-data.json (serve the folder over HTTP, not file://).", "error");
    }
  });

  document.getElementById("printBtn").addEventListener("click", () => window.print());

  // Drag & drop a .json file anywhere on the toolbar.
  const tb = document.getElementById("toolbar");
  ["dragover", "drop"].forEach((evt) =>
    tb.addEventListener(evt, (e) => e.preventDefault())
  );
  tb.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    // Route PDFs to the AI parser; treat everything else as JSON text.
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      parsePdf(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById("jsonInput").value = reader.result;
      renderFromRaw(reader.result, document.getElementById("estimateType").value,
        document.getElementById("jobNumber").value.trim());
    };
    reader.readAsText(file);
  });
}

document.addEventListener("DOMContentLoaded", init);
