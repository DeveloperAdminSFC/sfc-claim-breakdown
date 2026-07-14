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
site you leave this blank — uploads go to the existing Cloud Run backend instead (see
**Deploy** below).

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

## Deploy (Netlify)

This is a **pure static site with no secrets of its own** — nothing to hide, no build step,
no serverless function. When the API-key field is blank, uploads are sent to the existing
Cloud Run backend, which holds the Anthropic key and parses the PDF (`POST
/api/estimates/{job}/parse`). Cloud Run has no request-timeout limit, so large PDF parses
complete (Netlify Functions' ~10–26s cap was killing them).

1. Set `BACKEND_URL` at the top of `app.js` to the production Cloud Run backend URL.
2. Connect this repo to Netlify. There is **no build step** (`netlify.toml` sets
   `publish = "."`).
3. On the Cloud Run backend, add this Netlify site's URL to the `CORS_ORIGINS` env var so the
   browser is allowed to call it. **This is a manual Cloud Run config step, not part of this
   repo.**
4. Visit the live site, **leave the API-key field blank**, and upload a PDF.

## The parse

The extraction prompt and model (`claude-sonnet-4-6`) mirror the OI platform's claim
analyzer (`backend/app/routers/estimates.py`). Trade classification is intentionally left to
the user. Local calls (when a key is entered) go browser→Anthropic directly using the
`anthropic-dangerous-direct-browser-access` header; the deployed path posts the PDF to the
Cloud Run backend instead.

> Security note: a browser-entered key is visible to anyone who can open the page — fine for
> local use only. **Never commit a key.** The deployed site has no key of its own.

## Files

- `index.html` — toolbar, review/categorize table, printable document shell
- `styles.css` — screen + print-first styling (letter size, page breaks)
- `app.js` — parse (direct or via Cloud Run backend), trade grouping, editable review table, summary, print
- `netlify.toml` — Netlify config (static site, no build)
- `sample-data.json` — example claim so you can see the output with no API call
