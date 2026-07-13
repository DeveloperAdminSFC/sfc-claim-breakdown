# Claim Breakdown by Trade

A standalone, zero-build, zero-backend web tool. Upload an insurance claim/estimate
PDF, let Claude extract every line item, categorize each line by trade, and download
a one-page summary (O&P · Taxes · RCV · Depreciation · Non-Recoverable Dep. · ACV).

**Nothing is saved.** No server, no database. The PDF is parsed by a single direct
call from your browser to the Anthropic API. The only thing stored is your API key,
in this browser's localStorage, so you don't retype it.

## Run it

Serve the folder over HTTP (needed so the sample load works):

```
python -m http.server 8080
# then open http://localhost:8080
```

## Use it

1. **Paste your Anthropic API key** (`sk-ant-…`) into the key field. It stays in
   your browser — click **Forget** to clear it.
2. Click **Upload claim PDF** (or drag a `.pdf` onto the toolbar).
3. Claude extracts every line item and pre-guesses a trade for each. **Review the
   Trade column** and fix any that are wrong (per-row dropdown, or **Set all to…**
   for a bulk change). You can also toggle a line's **Non-Rec.** depreciation.
4. Click **Build summary**, then **Download summary (PDF)** (Print / Save as PDF).

No key handy? Click **Load sample** to see the whole flow with bundled example data.

## The numbers

**Page 1 — Summary by Trade**

| Trade | O&P | Taxes | RCV | Depreciation | Non-Rec. Dep. | ACV |
|---|---|---|---|---|---|---|

- **RCV − Depreciation = ACV** holds per line and per trade.
- **Non-Recoverable Depreciation** is derived: `depreciationType === "non-recoverable" ? depreciation : 0`.
  It is a subset of Depreciation.
- **O&P and Taxes** are estimate-wide only (RCV already includes them), so per-trade
  cells show `—` and the estimate totals appear in the Total row.
- Tick **Include per-trade detail pages** before building to append one page per
  trade listing every line item.

## The parse

The extraction prompt and model (`claude-sonnet-4-6`) mirror the OI platform's
claim analyzer (`backend/app/routers/estimates.py`), with an added per-line trade
classification. Browser→Anthropic calls use the
`anthropic-dangerous-direct-browser-access` header.

> Security note: an API key in a browser app is exposed to anyone who can open the
> page. This is fine for local/personal use. **Do not deploy this publicly with a
> key embedded, and never commit your key.**

## Files

- `index.html` — toolbar, review/categorize table, printable document shell
- `styles.css` — screen + print-first styling (letter size, page breaks)
- `app.js` — Anthropic parse, trade grouping, review UI, summary rendering, print
- `sample-data.json` — example claim so you can see the output with no API call
