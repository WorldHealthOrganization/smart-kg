#!/usr/bin/env node
// Negative tests for tools/validate.mjs.
//
// A validator is only worth its output if it FAILS on the things it claims to catch. Each case
// mutates a valid document into a specific defect and asserts the error names it. Four cases assert
// the opposite -- that something legitimate is NOT reported -- because a check that fires on the
// normal case trains people to ignore it.
//
// The documents are built here rather than committed. This repository holds the schema and no DAK
// data (docs/STORAGE.md), and a committed fixture large enough to be interesting is a dataset
// wearing a fixture's name. These are the smallest documents that exercise every rule.
//
//   node tools/negative-test.mjs
//   node tools/negative-test.mjs --emit <dir>   # write the valid documents out, for the tier-1 check

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateGraph, layerOf } from "./validate.mjs";
import { loadLayer } from "./ontology.mjs";

const NS = "https://example.org/dak";
const doc = (layer, nodes, edges) => ({
  "@context": `http://smart.who.int/kg/${layer}.context.jsonld`,
  id: `${NS}/kg/${layer}`,
  type: "Entity",
  ontologyVersion: "1.0",
  generatedAt: "2026-01-01T00:00:00Z",
  wasDerivedFrom: [{ path: "fixture", sha256: "0".repeat(64) }],
  nodes,
  edges,
});
const n = (id, type, label, properties = {}, extra = {}) =>
  ({ id, type, label, properties, derivation: "derived", ...extra });
const e = (predicate, source, target, extra = {}) =>
  ({ type: "Statement", predicate, source, target, derivation: "derived", ...extra });

// An inferred claim must say why and point at a source; these helpers keep that true by default so
// a test that removes one is testing the check rather than tripping over boilerplate.
const inferred = (why) => ({
  derivation: "inferred",
  note: why,
  evidence: { location: "fixture#1", quote: "…" },
});

const DMN_FILE = `${NS}/artifact/DT.EXAMPLE`;
const CITATION = `${NS}/citation/abc123abc123`;

const L1 = doc("l1", [
  n(DMN_FILE, "external-artifact", "Example decision table",
    { iri: DMN_FILE, targetKind: "dmn:DecisionTable" }),
  n(CITATION, "citation", "Example guideline (1)",
    { text: "Example guideline (1)", location: "fixture#rule1", numbering: "1",
      resolutionStatus: "unresolved" }),
], [
  e("appearsIn", CITATION, DMN_FILE),
]);

const DAK = `${NS}/kg/dak`;
const PERSONA = `${NS}/persona/data-clerk`;
const REQ = `${NS}/requirement/record-a-visit`;
const STMT = `${REQ}/statement/rec-01`;

const L2 = doc("l2", [
  n(DAK, "dak", "Example DAK", { id: "example.dak", name: "Example", title: "Example DAK",
    version: "0.1.0", status: "draft", canonicalUrl: NS, publisherName: "Example" }),
  n(PERSONA, "persona", "Data Clerk",
    { id: "Example.Persona.DataClerk", title: "Data Clerk", name: "DataClerk",
      sourceKind: "instance", resolutionStatus: "resolved" }),
  n(REQ, "functional-requirement", "Can record a visit",
    { id: "Example.Skills.RecordVisit", title: "Can record a visit", sourceKind: "instance" }),
  n(STMT, "requirement-statement", "REC-01",
    { key: "REC-01", label: "Record a visit", requirement: "Can record a visit.", conformance: "SHALL" }),
], [
  e("hasComponent", DAK, PERSONA, { qualifier: "personas", ...inferred("presence in the input tree") }),
  e("hasComponent", DAK, REQ, { qualifier: "requirements", ...inferred("presence in the input tree") }),
  e("hasStatement", REQ, STMT),
  e("fulfilledBy", REQ, PERSONA, {
    properties: { resolutionStatus: "resolved", matchedOn: "actor Canonical() == ActorDefinition instance id" },
    ...inferred("resolved by canonical reference, not by name matching"),
  }),
]);

const BPMN = `${NS}/artifact/Example.bpmn`;
const el = (id) => `${BPMN}#${id}`;
const GHOST = `${NS}/persona/ward-clerk`;

const L2_BPMN = doc("l2-bpmn", [
  n(BPMN, "bpmn-definitions", "Example collaboration",
    { id: "Definitions_Example", source: "fixture", sha256: "1".repeat(64) }),
  n(el("Process_1"), "bpmn-process", "Main", { id: "Process_1", name: "Main", isExecutable: false }),
  n(el("Pool_1"), "bpmn-participant", "Ward Clerk",
    { id: "Pool_1", name: "Ward Clerk", processRef: "Process_1" }),
  n(el("Task_1"), "bpmn-task", "Register client",
    { id: "Task_1", name: "Register client", taskType: "task", isSubProcess: false }),
  n(el("Task_2"), "bpmn-task", "Record visit",
    { id: "Task_2", name: "Record visit", taskType: "task", isSubProcess: false }),
  // A role the process names that no ActorDefinition defines. Marked unresolved so the gap is a
  // node that can be queried for, rather than a dangling edge any store would drop.
  n(GHOST, "persona", "Ward Clerk", { title: "Ward Clerk", resolutionStatus: "unresolved" },
    inferred("referenced by a BPMN participant but defined nowhere")),
], [
  e("contains", BPMN, el("Process_1")),
  e("contains", BPMN, el("Pool_1")),
  e("contains", el("Process_1"), el("Task_1")),
  e("contains", el("Process_1"), el("Task_2")),
  e("flowsTo", el("Task_1"), el("Task_2"), { properties: { flowId: "Flow_1", hasConditionExpression: false } }),
  e("performedBy", el("Pool_1"), GHOST, {
    properties: { resolutionStatus: "unresolved", matchedOn: "participant @name == ActorDefinition title" },
    ...inferred("no ActorDefinition carries this title"),
  }),
]);

const DMN = DMN_FILE;
const dEl = (id) => `${DMN}#${id}`;
const ELEMENT = `${NS}/data-element/hiv-status`;

const L2_DMN = doc("l2-dmn", [
  n(DMN, "dmn-definitions", "Example decision",
    { id: "DT.EXAMPLE", source: "fixture", sha256: "2".repeat(64) }),
  n(dEl("Decision_1"), "dmn-decision", "Determine eligibility",
    { id: "Decision_1", question: "Is the client eligible?" }),
  n(dEl("Table_1#table"), "dmn-decision-table", "Table", { id: "Table_1", hitPolicy: null }),
  n(dEl("Input_1"), "dmn-input-clause", "HIV status",
    { id: "Input_1", label: "HIV status", expression: "HIV status", typeRef: "string", ordinal: 0 }),
  n(dEl("Rule_1"), "dmn-rule", "rule 1", { id: "Rule_1", ordinal: 0 }),
  n(ELEMENT, "data-element", "HIV status",
    { name: "HIV status", extractionRule: "bare-expression", resolutionStatus: "unresolved" },
    inferred("recovered from a DMN input expression; no dictionary was available")),
], [
  e("contains", DMN, dEl("Decision_1")),
  e("contains", dEl("Decision_1"), dEl("Table_1#table")),
  e("contains", dEl("Table_1#table"), dEl("Input_1")),
  e("contains", dEl("Table_1#table"), dEl("Rule_1")),
  e("reads", dEl("Input_1"), ELEMENT, {
    properties: { resolutionStatus: "unresolved", extractionRule: "bare-expression" },
    ...inferred("the element name was read out of free text"),
  }),
  // Crosses into L1: the target is defined in the L1 document, not this one.
  e("citesSource", dEl("Rule_1"), CITATION, {
    properties: { text: "Example guideline (1)" },
    evidence: { location: "fixture#Rule_1", quote: "Example guideline (1)" },
  }),
]);

const ALL = [L1, L2, L2_BPMN, L2_DMN];

// --------------------------------------------------------------------------------------------
if (process.argv.includes("--emit")) {
  const dir = process.argv[process.argv.indexOf("--emit") + 1];
  mkdirSync(dir, { recursive: true });
  for (const d of ALL) {
    writeFileSync(join(dir, `${layerOf(d)}.json`), JSON.stringify(d, null, 2) + "\n");
  }
  console.log(`wrote ${ALL.length} valid documents to ${dir}`);
  process.exit(0);
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const index = (...docs) => new Map(docs.flatMap((d) => (d.nodes ?? []).map((x) => [x.id, x])));
const find = (d, type) => d.nodes.find((x) => x.type === type);
const findEdge = (d, predicate) => d.edges.find((x) => x.predicate === predicate);

const cases = [
  // --- rules that predate the subgraphs ---------------------------------------------------------
  ["unknown class is rejected", L1, (d) => { d.nodes[0].type = "wormhole"; }, /does not declare/],
  ["dangling edge target is rejected", L1, (d) => { d.edges[0].target = "urn:nope"; }, /defined in no document/],
  ["undeclared property is rejected", L1, (d) => { d.nodes[0].properties.colour = "blue"; }, /does not declare/],
  ["inferred node without evidence is rejected", L1, (d) => {
    d.nodes[1].derivation = "inferred"; d.nodes[1].note = "why";
  }, /carries no evidence/],
  ["citation claiming resolution without a resolvesTo edge is rejected", L1, (d) => {
    find(d, "citation").properties.resolutionStatus = "resolved";
  }, /claims resolutionStatus "resolved" but has no resolvesTo/],
  ["a citation with no verbatim text is rejected", L1, (d) => {
    delete find(d, "citation").properties.text;
  }, /carries no verbatim text/],
  ["version mismatch stops the run", L1, (d) => { d.ontologyVersion = "0.9"; }, /Nothing below was checked/],

  // --- the DAK component layer ------------------------------------------------------------------
  ["unlicensed edge is rejected", L2, (d) => {
    d.edges.push(e("contains", find(d, "requirement-statement").id, find(d, "persona").id));
  }, /is not licensed by the ontology/],
  ["a canonical join resolved with no evidence is rejected", L2, (d) => {
    delete findEdge(d, "fulfilledBy").evidence;
  }, /points at no evidence|carries no evidence/],
  ["an invented resolutionStatus is rejected", L2, (d) => {
    findEdge(d, "fulfilledBy").properties.resolutionStatus = "probably";
  }, /permitted values are/],
  ["an undeclared property on a DAK component is rejected", L2, (d) => {
    find(d, "dak").properties.budget = "none of your business";
  }, /does not declare/],

  // --- the BPMN subgraph -------------------------------------------------------------------------
  ["a subgraph may not license an edge its ontology does not", L2_BPMN, (d) => {
    d.edges.push(e("flowsTo", find(d, "bpmn-participant").id, find(d, "bpmn-task").id));
  }, /is not licensed by the ontology/],
  ["a join resolved against a placeholder is rejected", L2_BPMN, (d) => {
    findEdge(d, "performedBy").properties.resolutionStatus = "resolved";
  }, /cannot be resolved against a placeholder/],

  // --- the DMN subgraph --------------------------------------------------------------------------
  ["a DMN clause may not read a persona", L2_DMN, (d) => {
    d.edges.push(e("reads", find(d, "dmn-input-clause").id, PERSONA));
  }, /is not licensed by the ontology/],
  ["an unknown class is rejected in a subgraph too", L2_DMN, (d) => {
    find(d, "dmn-rule").type = "dmn-wormhole";
  }, /does not declare/],

  // --- what must NOT be reported ------------------------------------------------------------------
  ["a free-text BPMN branch label is not a finding", L2_BPMN, (d) => {
    findEdge(d, "flowsTo").qualifier = "Something nobody has written before";
  }, null],
  ["an unresolved join is a legitimate state", L2_BPMN, null, null],
  ["a reference into another layer's document resolves across the set", L2_DMN, null, null],
  ["the DAK component layer conforms", L2, null, null],
  ["L1 conforms", L1, null, null],
];

let failures = 0;
for (const [name, base, mutate, expect] of cases) {
  const d = clone(base);
  if (mutate) mutate(d);
  const { errors } = validateGraph(d, loadLayer(layerOf(d)),
                                   index(d, ...ALL.filter((x) => x !== base)));
  if (expect === null) {
    if (errors.length) { console.error(`FAIL  ${name}\n      unexpected: ${errors[0]}`); failures++; }
    else console.log(`ok    ${name}`);
    continue;
  }
  const hit = errors.find((x) => expect.test(x));
  if (hit) console.log(`ok    ${name}\n      ${hit.slice(0, 108)}`);
  else {
    console.error(`FAIL  ${name}\n      expected /${expect.source}/, got: ` +
                  (errors.length ? errors.join(" | ").slice(0, 200) : "(no errors at all)"));
    failures++;
  }
}

console.log(`\n${cases.length - failures}/${cases.length} negative tests pass`);
process.exit(failures ? 1 : 0);
