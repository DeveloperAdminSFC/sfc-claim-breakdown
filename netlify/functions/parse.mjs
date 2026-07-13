/* =============================================================================
   Netlify Function: /api/parse  →  /.netlify/functions/parse
   -----------------------------------------------------------------------------
   Server-side proxy so the deployed site never ships the Anthropic API key to the
   browser. It receives a base64 PDF, calls Claude with the same prompt + model the
   OI platform uses, and returns the parsed { items, summary } JSON.

   The key lives ONLY here, read from the ANTHROPIC_API_KEY environment variable
   (set it in Netlify → Site settings → Environment variables). Nothing is stored.

   Runtime: Netlify Functions v2 (Node 18+, global fetch). No dependencies.
   ========================================================================== */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

// Must match the prompt in app.js. Kept in sync by hand (one constant).
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

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: "Server is missing ANTHROPIC_API_KEY." });

  let pdf_b64;
  try {
    ({ pdf_b64 } = await req.json());
  } catch {
    return json(400, { error: "Expected JSON body { pdf_b64 }." });
  }
  if (!pdf_b64 || typeof pdf_b64 !== "string") {
    return json(400, { error: "Missing pdf_b64." });
  }

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
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
  } catch (e) {
    return json(502, { error: "Could not reach the AI service." });
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return json(502, { error: "AI service error: " + (data?.error?.message || res.statusText) });
  }
  if (data?.stop_reason === "max_tokens") {
    return json(502, { error: "The estimate is too large to parse in one pass. Try splitting the PDF." });
  }

  const text = (data?.content || []).map((b) => b.text || "").join("").trim();
  if (!text) return json(502, { error: "The AI returned an empty response." });

  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return json(502, { error: "The AI did not return JSON." });

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return json(502, { error: "The AI returned invalid JSON." });
  }

  return json(200, { items: parsed.items || [], summary: parsed.summary || {} });
};
