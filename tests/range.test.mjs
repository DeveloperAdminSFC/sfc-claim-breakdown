// Node harness for the pure logic in app.js — no browser, no deps.
//   node tests/range.test.mjs
// app.js is a classic script (no exports); it's loaded in a vm context with a stub
// `document` (only init() touches the DOM, and it's gated behind DOMContentLoaded).
// Top-level function declarations land on the context global, so parseLineRange,
// assignDisplayNumbers, chunkTradeItems, and computePageRanges are reachable directly.

import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const sandbox = {
  console,
  document: {
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; },
  },
  fetch: () => Promise.reject(new Error("no network in tests")),
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "app.js" });

const { parseLineRange, assignDisplayNumbers, packRowsByHeight, computePageRanges } = sandbox;
for (const [name, fn] of Object.entries({ parseLineRange, assignDisplayNumbers, packRowsByHeight, computePageRanges })) {
  assert.equal(typeof fn, "function", `${name} not exposed by app.js`);
}

// ---- Fixture: LITKE-shaped — 1..48 unprefixed (plus a 21b) then Contents C1..C10 ---- //
function litkeItems() {
  const items = [];
  for (let n = 1; n <= 48; n++) {
    items.push({ number: String(n), section: "" });
    if (n === 21) items.push({ number: "21b", section: "" }); // letter-suffix line
  }
  for (let n = 1; n <= 10; n++) items.push({ number: String(n), section: "Contents" });
  return assignDisplayNumbers(items);
}
const items = litkeItems();

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}
// vm-realm arrays/objects carry foreign prototypes, which deepStrictEqual rejects —
// re-realm results before comparing.
const local = (v) => JSON.parse(JSON.stringify(v));
const range = (str) => {
  const { wanted, bad } = parseLineRange(str, items);
  return { wanted: new Set(wanted), bad: [...bad] };
};
const sorted = (set) => [...set].sort();

// ---- Display-number sanity (prefix scheme) ---- //
t("displayNumbers: unprefixed first section, C-prefix for Contents (real collision)", () => {
  assert.equal(items[0].displayNumber, "1");
  assert.equal(items.find((i) => i.number === "21b").displayNumber, "21b");
  assert.equal(items[items.length - 1].displayNumber, "C10");
});

t("continuous numbering across many sections → NO prefixes at all (Levi King shape)", () => {
  // 7 sections, numbers 1..32 continuous document-wide — unique everywhere.
  const sections = [
    ["Dwelling Roof", 1, 13], ["Gutter/Downspout - Back Elevation", 14, 15],
    ["Garage Roof", 16, 21], ["Garage Gutters", 22, 22], ["Siding", 23, 28],
    ["Debris Removal", 29, 30], ["Labor Minimums Applied", 31, 32],
  ];
  const levi = [];
  for (const [sec, lo, hi] of sections)
    for (let n = lo; n <= hi; n++) levi.push({ number: String(n), section: sec });
  assignDisplayNumbers(levi);
  assert.ok(levi.every((it) => it.displayNumber === String(it.number)), "raw numbers, no prefixes");
  assert.ok(levi.every((it) => it.sectionPrefix === ""));
  // Ranges work plain across section boundaries (keys are the raw global numbers).
  const { wanted, bad } = parseLineRange("16-21", levi);
  assert.equal(bad.length, 0);
  assert.equal(new Set(wanted).size, 6);
});

t("only colliding sections get prefixes; prefixes are letters-only", () => {
  const fx = [];
  const add = (sec, lo, hi) => { for (let n = lo; n <= hi; n++) fx.push({ number: String(n), section: sec }); };
  add("Dwelling Roof", 1, 5);
  add("Garage Roof", 1, 3);      // collides with 1-5 → prefixed
  add("Garage Gutters", 1, 2);   // collides → prefixed, distinct from Garage Roof
  add("Siding", 6, 7);           // 6-7 unseen → NOT prefixed
  assignDisplayNumbers(fx);
  const pfx = (sec) => fx.find((i) => i.section === sec).sectionPrefix;
  assert.equal(pfx("Dwelling Roof"), "");
  assert.equal(pfx("Siding"), "");
  assert.equal(pfx("Garage Roof"), "G");
  assert.equal(pfx("Garage Gutters"), "GG"); // second G-section → two-letter, never "G2"
  assert.ok(fx.every((i) => /^[A-Z]*$/.test(i.sectionPrefix)), "letters-only prefixes");
  const dns = fx.map((i) => i.displayNumber);
  assert.equal(new Set(dns).size, dns.length, "displayNumbers unique");
  // Prefixed ranges still index-walk: "G1-GG2" spans Garage Roof + Garage Gutters.
  const { wanted, bad } = parseLineRange("G1-GG2", fx);
  assert.equal(bad.length, 0);
  assert.equal(wanted.size, 5);
});

// ---- Cross-section document-order ranges ---- //
t('"40-C10" spans document order: 40..48 + C1..C10 = 19 lines', () => {
  const { wanted, bad } = range("40-C10");
  assert.equal(bad.length, 0);
  assert.equal(wanted.size, 19);
  for (const dn of ["40", "48", "C1", "C10"]) assert.ok(wanted.has(dn), dn);
  assert.ok(!wanted.has("39") && !wanted.has("21b"));
});
t('"45-C3" → 45..48 + C1..C3 = 7 lines', () => {
  const { wanted, bad } = range("45-C3");
  assert.equal(bad.length, 0);
  assert.deepEqual(sorted(wanted), ["45", "46", "47", "48", "C1", "C2", "C3"]);
});
t('"C5-40" reversed endpoints swap (≡ "40-C5")', () => {
  assert.deepEqual(sorted(range("C5-40").wanted), sorted(range("40-C5").wanted));
  assert.equal(range("C5-40").wanted.size, 14); // 40..48 (9) + C1..C5 (5)
});
t('"c2-c5" case-insensitive, within-prefix via the same walk', () => {
  const { wanted, bad } = range("c2-c5");
  assert.equal(bad.length, 0);
  assert.deepEqual(sorted(wanted), ["C2", "C3", "C4", "C5"]);
});
t('"21-21b" letter-suffix endpoint index-walks', () => {
  assert.deepEqual(sorted(range("21-21b").wanted), ["21", "21b"]);
});
t('"40-C99" missing endpoint → bad, quoted VERBATIM as typed', () => {
  const { wanted, bad } = range("40-C99");
  assert.equal(wanted.size, 0);
  assert.deepEqual(bad, ["40-C99"]);
  assert.deepEqual(range("40-c99").bad, ["40-c99"]); // as typed, not uppercased
});

// ---- Plain-numeric ranges keep the old clamp semantics ---- //
t('"3-7" → 5 lines, unchanged', () => {
  const { wanted, bad } = range("3-7");
  assert.equal(bad.length, 0);
  assert.deepEqual(sorted(wanted), ["3", "4", "5", "6", "7"]);
});
t('"1-999" numeric catch-all: every unprefixed line, never bad', () => {
  const { wanted, bad } = range("1-999");
  assert.equal(bad.length, 0);
  assert.equal(wanted.size, 48); // 1..48; excludes 21b (not a plain number) and C-lines
  assert.ok(!wanted.has("C1") && !wanted.has("21b"));
});
t('"40-48" clamps over missing members without complaint', () => {
  const partial = assignDisplayNumbers([
    ...[40, 41, 42, 44, 45].map((n) => ({ number: String(n), section: "" })),
  ]);
  const { wanted, bad } = parseLineRange("40-48", partial);
  assert.equal(bad.length, 0);
  assert.deepEqual(sorted(wanted), ["40", "41", "42", "44", "45"]);
});
t('"7-3" numeric reversed swaps', () => {
  assert.deepEqual(sorted(range("7-3").wanted), ["3", "4", "5", "6", "7"]);
});

// ---- Single refs ---- //
t('single refs: present added, absent NAMED (no more silent drop)', () => {
  const { wanted, bad } = range("7, C2, 21b, C99, 50");
  assert.deepEqual(sorted(wanted), ["21b", "7", "C2"]);
  assert.deepEqual(bad, ["C99", "50"]);
});

// ---- Mixed lists ---- //
t('"3, 40-C10, C2" mixed list', () => {
  const { wanted, bad } = range("3, 40-C10, C2");
  assert.equal(bad.length, 0);
  assert.equal(wanted.size, 20); // "3" + the 19-line range; C2 is already inside 40-C10
});
t('bad tokens do not poison good ones', () => {
  const { wanted, bad } = range("3, 40-C99, C2");
  assert.deepEqual(sorted(wanted), ["3", "C2"]);
  assert.deepEqual(bad, ["40-C99"]);
});
t('malformed tokens ("C1-C3-C5", "-5", "5-") → bad verbatim', () => {
  assert.deepEqual(range("C1-C3-C5").bad, ["C1-C3-C5"]);
  assert.deepEqual(range("-5").bad, ["-5"]);
  assert.deepEqual(range("5-").bad, ["5-"]);
});

// ---- Pagination helpers ---- //
const packLens = (heights, budget) => local(packRowsByHeight(heights, budget)).map((c) => c.length);

t("packRowsByHeight: uniform short rows fill to the budget", () => {
  // 45 rows × 31px, 806px budget → 26 per page (26×31=806 exactly fits, 27 would spill)
  assert.deepEqual(packLens(Array(45).fill(31), () => 806), [26, 19]);
});
t("packRowsByHeight: tall wrapped rows pack fewer per page", () => {
  // Alternating 31/95px rows: packing follows the running sum, not a count
  const heights = Array.from({ length: 20 }, (_, i) => (i % 2 ? 95 : 31));
  const chunks = local(packRowsByHeight(heights, () => 400));
  for (const c of chunks) {
    const sum = c.reduce((a, i) => a + heights[i], 0);
    assert.ok(sum <= 400, `chunk sum ${sum} > budget`);
  }
  assert.equal(chunks.flat().length, 20); // every row placed exactly once
  assert.deepEqual(chunks.flat(), heights.map((_, i) => i)); // in order
});
t("packRowsByHeight: first page smaller budget than cont pages", () => {
  // budget 100 for page 0, 200 after (cont header is shorter)
  assert.deepEqual(packLens(Array(10).fill(50), (ci) => (ci === 0 ? 100 : 200)), [2, 4, 4]);
});
t("packRowsByHeight: a row taller than the whole budget gets its own page", () => {
  assert.deepEqual(packLens([50, 999, 50], () => 100), [1, 1, 1]);
});
t("computePageRanges: 45-line trade shifts every later structure's range", () => {
  // Structure A: trades with [3, 1] chunks (a 45-line trade + a small one) → divider 2, pages 3-6.
  // Structure B: one 1-chunk trade → divider 7, page 8 (singular).
  const [a, b] = local(computePageRanges([[3, 1], [1]]));
  assert.deepEqual(a, { start: 3, end: 6, label: "Pages: 3–6" });
  assert.deepEqual(b, { start: 8, end: 8, label: "Page: 8" });
});
t("computePageRanges: plain two-structure LITKE-ish shape", () => {
  const [a, b] = local(computePageRanges([[1, 1, 1], [1, 1]]));
  assert.deepEqual(a, { start: 3, end: 5, label: "Pages: 3–5" });
  assert.deepEqual(b, { start: 7, end: 8, label: "Pages: 7–8" });
});
t("computePageRanges: a 2-sheet summary shifts every range by one", () => {
  const [a, b] = local(computePageRanges([[1, 1, 1], [1, 1]], 2));
  assert.deepEqual(a, { start: 4, end: 6, label: "Pages: 4–6" });
  assert.deepEqual(b, { start: 8, end: 9, label: "Pages: 8–9" });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
