# Claim Breakdown by Trade

A standalone, zero-build web app that renders an insurance claim as a print-ready
breakdown: a trade-summary sheet on page 1, then one page per trade listing every
line item. Open `index.html`, load a claim, and Print / Save PDF.

## Run it

- **Locally:** serve the folder over HTTP (needed so the sample and file loads work).
  ```
  python3 -m http.server 8080
  # then open http://localhost:8080
  ```
  Opening `index.html` directly via `file://` works for pasting JSON, but the
  "Load sample" button needs HTTP.
- **Deploy:** drop the folder onto Netlify (or any static host). No build step.

## Loading a claim — three ways

1. **By Job #** — enter the Job #, pick Initial/Final, set your **API base URL**
   (where the FastAPI backend is reachable), and click **Load**. The app calls
   `GET {API_BASE}/api/estimates/{job_number}`. The backend must allow this
   origin (CORS).
2. **Paste JSON** — paste into the textarea and click **Render pasted JSON**.
3. **File** — choose or drag-drop a `.json` file onto the toolbar.

Accepted JSON shapes:
- Full estimates response: `{ "initial": { "items": [...], "metadata": {...} }, "final": {...} }`
- A single group: `{ "items": [...], "metadata": {...} }`
- A raw items array: `[ { ... }, { ... } ]`

## The sheet

**Page 1 — Summary by Trade**

| Trade | O&P | Taxes | RCV | Depreciation | Non-Rec. Dep. | ACV |
|---|---|---|---|---|---|---|

**Pages 2+** — one page per trade: `Line # | Description | Quantity | RCV | Depreciation | Non-Rec. Dep. | ACV`, with a per-trade total row.

## Where the numbers come from (mirrors the OI platform)

- **Grouping by trade** replicates `groupByTrade()` from
  `frontend/src/app/jobs/[jobNumber]/estimate-print/page.tsx`: items are bucketed
  by `item.trade` (default `"Not Categorized"`), ordered by `TRADE_OPTIONS`, and
  `rcv` / `depreciation` / `acv` are summed per trade.
- **Non-Recoverable Depreciation** is derived, not stored:
  `depreciationType === "non-recoverable" ? depreciation : 0` — the same rule used
  in `estimates-tab.tsx`. It is a **subset** of the Depreciation column, so
  `RCV − Depreciation = ACV` still holds per trade.
- **Line-number sort** uses the natural sort from `estimate-print/page.tsx`.

## About the O&P and Taxes columns

O&P and Taxes are **not** tracked per trade anywhere in the source data. The PDF
parser explicitly ignores the per-line O&P/Tax columns, and RCV figures already
include tax and O&P. These values exist only as estimate-wide totals
(`metadata.total_op`, `metadata.total_tax`).

So per-trade O&P/Taxes cells render `—` ("if applicable"), and the estimate-wide
figures appear in the **Total** row. If the estimate has no O&P/Tax on it, the
Total row shows `—` there too.

## Files

- `index.html` — page shell and controls
- `styles.css` — print-first document styling (letter size, page breaks)
- `app.js` — grouping logic, input parsing, fetch, rendering, print
- `sample-data.json` — example claim so you can see it immediately
