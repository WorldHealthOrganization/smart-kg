#!/usr/bin/env node
// Compares a committed fixture against a freshly extracted one, ignoring what legitimately differs
// between two runs: the timestamp, and the paths the sources were read from.
//
// Everything else must match -- the SHA-256 of every source included. That is the point: if
// smart-base edits the BCG table, this fails with the hash that changed, rather than the fixture
// continuing to describe a file that no longer exists in that form.
//
//   node tools/compare-extract.mjs <committed.json> <fresh.json>

import { readFileSync } from "node:fs";

const normalise = (doc) => {
  const d = JSON.parse(JSON.stringify(doc));
  delete d.generatedAt;
  // The fixture is extracted from a relative path and CI from a clone under /tmp, so a path is
  // reduced to its file name (keeping any #fragment, which identifies an element rather than a
  // directory). The file identity that matters is its SHA-256, and that IS compared -- an earlier
  // version of this normaliser matched only paths containing "input/" and reported 35 nodes as
  // changed when nothing had, which is the kind of noise that gets a check switched off.
  for (const src of d.wasDerivedFrom ?? []) delete src.path;
  const stripPath = (v) => {
    if (typeof v !== "string") return v;
    const [path, ...frag] = v.split("#");
    if (!path.includes("/")) return v;
    return [path.slice(path.lastIndexOf("/") + 1), ...frag].join("#");
  };
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) v[k] = k === "location" || k === "source" ? stripPath(v[k]) : walk(v[k]);
      return v;
    }
    return v;
  };
  return walk(d);
};

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error("usage: compare-extract.mjs <committed.json> <fresh.json>"); process.exit(2); }

const A = normalise(JSON.parse(readFileSync(a, "utf8")));
const B = normalise(JSON.parse(readFileSync(b, "utf8")));

if (JSON.stringify(A) === JSON.stringify(B)) {
  console.log(`${a}: matches a fresh extraction from upstream`);
  process.exit(0);
}

// Say what moved, rather than dumping two documents at the reader.
const idx = (d) => new Map((d.nodes ?? []).map((n) => [n.id, n]));
const [ia, ib] = [idx(A), idx(B)];
const gone = [...ia.keys()].filter((k) => !ib.has(k));
const added = [...ib.keys()].filter((k) => !ia.has(k));
const changed = [...ia.keys()].filter((k) => ib.has(k)
  && JSON.stringify(ia.get(k)) !== JSON.stringify(ib.get(k)));

console.error(`${a}: DIFFERS from a fresh extraction from upstream.`);
for (const [i, s] of (A.wasDerivedFrom ?? []).entries()) {
  const t = B.wasDerivedFrom?.[i];
  if (t && s.sha256 !== t.sha256) console.error(`  source ${i} hash changed: ${s.sha256} -> ${t.sha256}`);
}
if (gone.length) console.error(`  ${gone.length} node(s) no longer produced, e.g. ${gone[0]}`);
if (added.length) console.error(`  ${added.length} new node(s), e.g. ${added[0]}`);
if (changed.length) console.error(`  ${changed.length} node(s) changed, e.g. ${changed[0]}`);

const key = (e) => `${e.predicate}|${e.source}|${e.target}`;
const ea = new Map((A.edges ?? []).map((e) => [key(e), e]));
const eb = new Map((B.edges ?? []).map((e) => [key(e), e]));
const eGone = [...ea.keys()].filter((k) => !eb.has(k));
const eAdded = [...eb.keys()].filter((k) => !ea.has(k));
const eChanged = [...ea.keys()].filter((k) => eb.has(k)
  && JSON.stringify(ea.get(k)) !== JSON.stringify(eb.get(k)));
if (eGone.length) console.error(`  ${eGone.length} edge(s) no longer produced, e.g. ${eGone[0]}`);
if (eAdded.length) console.error(`  ${eAdded.length} new edge(s), e.g. ${eAdded[0]}`);
if (eChanged.length) {
  console.error(`  ${eChanged.length} edge(s) changed, e.g. ${eChanged[0]}`);
  const [x, y] = [ea.get(eChanged[0]), eb.get(eChanged[0])];
  for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) {
      console.error(`      ${f}:\n        committed: ${JSON.stringify(x[f]).slice(0, 160)}` +
                    `\n        fresh:     ${JSON.stringify(y[f]).slice(0, 160)}`);
    }
  }
}
// Never exit "differs" without saying where. A check that reports a failure it cannot localise is
// one nobody can act on.
if (!gone.length && !added.length && !changed.length
    && !eGone.length && !eAdded.length && !eChanged.length) {
  console.error(`  The difference is outside nodes and edges. Committed vs fresh document keys:`);
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) {
      console.error(`      ${k}:\n        committed: ${JSON.stringify(A[k]).slice(0, 200)}` +
                    `\n        fresh:     ${JSON.stringify(B[k]).slice(0, 200)}`);
    }
  }
}
console.error(`  Re-run the extractor and commit the result, or fix what regressed.`);
process.exit(1);
