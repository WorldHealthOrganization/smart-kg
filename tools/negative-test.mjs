#!/usr/bin/env node
// Negative tests for tools/validate.mjs.
//
// A validator is only worth its output if it FAILS on the things it claims to catch. Each case
// below mutates a valid document into a specific defect and asserts the error names it. They are
// here rather than in a test framework so CI needs no install step.
//
//   node tools/negative-test.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGraph, layerOf } from "./validate.mjs";
import { loadLayer } from "./ontology.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (f) => JSON.parse(readFileSync(join(ROOT, "examples", f), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

const L1 = load("immz-bcg-citations.json");
const L2 = load("l2-daklifecycle-bcg.json");
const index = (...docs) => new Map(docs.flatMap((d) => (d.nodes ?? []).map((n) => [n.id, n])));

const find = (doc, type) => doc.nodes.find((n) => n.type === type);
const findEdge = (doc, predicate) => doc.edges.find((e) => e.predicate === predicate);

const cases = [
  // --- the checks that predate L2, still holding -----------------------------------------------
  ["unknown class is rejected", L1, (d) => { d.nodes[0].type = "wormhole"; }, /does not declare/],
  ["dangling edge target is rejected", L1, (d) => { d.edges[0].target = "urn:nope"; }, /defined in no document/],
  ["undeclared property is rejected", L1, (d) => { d.nodes[0].properties.colour = "blue"; }, /does not declare/],
  ["inferred node without evidence is rejected", L1, (d) => {
    d.nodes[1].derivation = "inferred"; delete d.nodes[1].evidence;
  }, /carries no evidence/],
  ["citation claiming resolution without a resolvesTo edge is rejected", L1, (d) => {
    find(d, "citation").properties.resolutionStatus = "resolved";
  }, /claims resolutionStatus "resolved" but has no resolvesTo/],
  ["version mismatch stops the run", L1, (d) => { d.ontologyVersion = "0.9"; }, /Nothing below was checked/],

  // --- L2: licensing --------------------------------------------------------------------------
  ["unlicensed edge is rejected", L2, (d) => {
    // A persona does not contain a data element, and the ontology says so.
    d.edges.push({ type: "Statement", predicate: "contains",
                   source: find(d, "persona").id, target: find(d, "data-element").id,
                   derivation: "derived" });
  }, /is not licensed by the ontology/],
  ["an L1 class an L2 edge does not license is still rejected", L2, (d) => {
    d.edges.push({ type: "Statement", predicate: "reads",
                   source: find(d, "input-clause").id, target: find(d, "persona").id,
                   derivation: "derived" });
  }, /is not licensed by the ontology/],

  // --- L2: the cross-format joins -------------------------------------------------------------
  ["a join resolved against a placeholder is rejected", L2, (d) => {
    // The target persona is itself marked unresolved; claiming the match resolved is a match
    // asserted against a thing that was never found.
    const e = d.edges.find((x) => x.predicate === "performedBy"
                               && x.properties?.resolutionStatus !== "resolved");
    e.properties.resolutionStatus = "resolved";
  }, /cannot be resolved against a placeholder/],
  ["a resolved join with no evidence is rejected", L2, (d) => {
    const e = d.edges.find((x) => x.predicate === "performedBy"
                               && x.properties?.resolutionStatus === "resolved");
    delete e.evidence;
  }, /points at no evidence|carries no evidence/],
  ["an invented resolutionStatus is rejected", L2, (d) => {
    findEdge(d, "performedBy").properties.resolutionStatus = "probably";
  }, /permitted values are/],

  // --- L2: what must NOT be rejected ----------------------------------------------------------
  ["a free-text BPMN branch label is not a finding", L2, (d) => {
    d.edges.find((e) => e.predicate === "flowsTo").qualifier = "Something nobody has written before";
  }, null],
  ["an unresolved join is a legitimate state", L2, null, null],
];

let failures = 0;
for (const [name, base, mutate, expect] of cases) {
  const doc = clone(base);
  if (mutate) mutate(doc);
  const other = base === L1 ? L2 : L1;
  const { errors } = validateGraph(doc, loadLayer(layerOf(doc)), index(doc, other));

  if (expect === null) {
    if (errors.length) {
      console.error(`FAIL  ${name}\n      expected no error, got: ${errors[0]}`);
      failures++;
    } else console.log(`ok    ${name}`);
    continue;
  }
  const hit = errors.find((e) => expect.test(e));
  if (hit) console.log(`ok    ${name}\n      ${hit.slice(0, 110)}`);
  else {
    console.error(`FAIL  ${name}\n      expected /${expect.source}/, got: ` +
                  (errors.length ? errors.join(" | ").slice(0, 200) : "(no errors at all)"));
    failures++;
  }
}

console.log(`\n${cases.length - failures}/${cases.length} negative tests pass`);
process.exit(failures ? 1 : 0);
