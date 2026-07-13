# Claim Breakdown by Trade

A standalone, zero-build web tool. Upload an insurance claim/estimate PDF, let Claude
extract every line item, categorize each line by trade, edit any amounts, and download a
one-page summary (O&P · Taxes · RCV · Depreciation · Non-Recoverable Dep. · ACV).

**Nothing is saved.** No database. The PDF is parsed by a single Claude call and everything
else stays in the page for the session — gone on refresh.

## Run it locally

Serve the folder over HTTP (needed so the sample load works):

```
python -m http.server 8080
# then open http://localhost:8080
```

For local testing, paste your Anthropic API key (`sk-ant-…`) into the key field. It is
stored only in your browser's localStorage; click **Forget** to clear it. On the deployed
site you leave this blank — the server holds the key (see **Deploy** below).

## Use it

1. Click **Upload claim PDF** (or drag a `.pdf` onto the toolbar).
2. Claude extracts every line item. **Every line starts "Not Categorized."**
3. **Categorize by trade** — tick the checkboxes for a group of lines (or the header
   **select-all**), pick a trade, and click **Apply to selected**. Repeat per trade. You
   can also set a single line via its row dropdown.
4. **Edit amounts** if the parse got one wrong: RCV, Depreciation, and Non-Recoverable Dep.
   are editable. **ACV auto-updates to RCV − Depreciation.**
5. Click **Build summary**, then **Download summary (PDF)** (Print / Save as PDF).

No key handy? Click **Load sample** to walk the whole flow with bundled example data — no
API call.

## The numbers

**Page 1 — Summary by Trade**

| Trade | O&P | Taxes | RCV | Depreciation | Non-Rec. Dep. | ACV |
|---|---|---|---|---|---|---|

- **RCV − Depreciation = ACV**, enforced per line and per trade.
- **Non-Recoverable Depreciation** is its own editable per-line amount (a subset of
  Depreciation) and is summed into the Non-Rec. Dep. column.
- **O&P and Taxes** are estimate-wide only (RCV already includes them), so per-trade cells
  show `—` and the estimate totals appear in the Total row.
- Tick **Include per-trade detail pages** before building to append one page per trade.

## Deploy (Netlify) — with the key hidden

The deployed site must not ship the API key to browsers. A serverless function holds it.

1. Connect this repo to Netlify. There is **no build step** (`netlify.toml` sets
   `publish = "."` and the functions directory).
2. In **Site settings → Environment variables**, add `ANTHROPIC_API_KEY` = your key.
   That value is read only by `netlify/functions/parse.mjs` at runtime — never sent to the
   browser, never in the repo.
3. Visit the live site, **leave the API-key field blank**, and upload a PDF. The app POSTs
   the PDF to `/api/parse`; the function calls Claude with the secret key and returns the
   parsed line items.

> The key belongs in the **Netlify** env var (the runtime secret). A GitHub Actions secret
> is only needed if you deploy via CI; it is not required for the standard Netlify Git
> integration.

**Size caveat:** Netlify caps function request bodies near 6 MB and base64 inflates a PDF
~1.33×, so the hosted parser rejects PDFs over ~4 MB (the app warns you). For a large PDF,
paste a key to parse it directly, split the PDF, or move the proxy to Cloudflare Workers
(same code shape, higher limit).

## The parse

The extraction prompt and model (`claude-sonnet-4-6`) mirror the OI platform's claim
analyzer (`backend/app/routers/estimates.py`). Trade classification is intentionally left to
the user. Local browser→Anthropic calls use the `anthropic-dangerous-direct-browser-access`
header; the deployed path goes through the Netlify function instead.

> Security note: a browser-entered key is visible to anyone who can open the page — fine for
> local use. **Never commit a key, and don't deploy with a key embedded in client code** —
> that's exactly what the Netlify function avoids.

## Files

- `index.html` — toolbar, review/categorize table, printable document shell
- `styles.css` — screen + print-first styling (letter size, page breaks)
- `app.js` — parse (direct or via proxy), trade grouping, editable review table, summary, print
- `netlify/functions/parse.mjs` — serverless proxy that holds the API key
- `netlify.toml` — Netlify config (no build, `/api/parse` route)
- `sample-data.json` — example claim so you can see the output with no API call
