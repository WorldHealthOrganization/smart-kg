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
// Every layer shares one schemaVersion -- loadLayer refuses an import across versions -- so the
// fixtures read it rather than pinning a copy that goes stale on the next bump.
const VERSION = loadLayer("l1").own.schemaVersion;
const doc = (layer, nodes, edges) => ({
  "@context": `http://smart.who.int/kg/${layer}.context.jsonld`,
  id: `${NS}/kg/${layer}`,
  type: "Entity",
  ontologyVersion: VERSION,
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

// The normative half of L1: one guideline, its annex, a key question in PICO form, one row of its
// evidence profile, and three statements of different kinds answering the question -- the shape
// the WHO guideline development handbook prescribes (chapters 7, 9 and 10).
const GL = `${NS}/publication/example-guideline`;
const ANNEX = `${GL}/annex-1`;
const SEC = `${GL}/section/3`;
const SUBSEC = `${GL}/section/3.1`;
const KQ = `${GL}/key-question/1`;
const EVID = `${GL}/evidence/kq1-mortality`;
const HI = `${NS}/health-intervention/example-vaccine`;
const REC = `${GL}/recommendation/1`;
const GPS = `${GL}/recommendation/2`;
const NOREC = `${GL}/recommendation/3`;
const quoted = (q) => ({ ...inferred("extracted from the guideline PDF"),
                         evidence: { location: "example-guideline.pdf p12", quote: q } });

const L1 = doc("l1", [
  n(DMN_FILE, "external-artifact", "Example decision table",
    { iri: DMN_FILE, targetKind: "dmn:DecisionTable" }),
  n(CITATION, "citation", "Example guideline (1)",
    { text: "Example guideline (1)", location: "fixture#rule1", numbering: "1",
      resolutionStatus: "unresolved" }),
  n(GL, "publication", "Example guideline",
    { title: "Example guideline", issued: "2024-01-01", publicationType: "standard-guideline",
      grcStatus: "approved", reviewBy: "2029-01-01", sha256: "3".repeat(64) }),
  n(ANNEX, "publication", "Example guideline, web annex 1",
    { title: "Web annex 1: evidence profiles", publicationType: "supplement" }),
  n(SEC, "publication-section", "3 Recommendations", { heading: "Recommendations", number: "3" }),
  n(SUBSEC, "publication-section", "3.1 Vaccination", { heading: "Vaccination", number: "3.1", pageRange: "12-13" }),
  n(KQ, "key-question", "KQ1", {
    text: "In infants, does vaccine X compared with no vaccination reduce mortality?",
    population: "infants", intervention: "vaccine X", comparator: "no vaccination",
    outcomes: ["mortality", "serious adverse events"] }, quoted("In infants, does vaccine X…")),
  n(EVID, "evidence", "KQ1 mortality", {
    outcome: "mortality", outcomeImportance: "critical", certainty: "moderate", studyCount: 4 },
    { ...inferred("one row of the GRADE evidence profile"),
      evidence: { location: "annex-1.pdf p3", quote: "Mortality … MODERATE" } }),
  n(HI, "health-intervention", "Vaccine X", { name: "Vaccine X" }),
  n(REC, "recommendation", "Recommendation 1", {
    statement: "We recommend vaccine X for all infants.", kind: "recommendation",
    direction: "for", strength: "strong", overallCertainty: "moderate", status: "current" },
    quoted("We recommend vaccine X for all infants.")),
  n(GPS, "recommendation", "Good practice statement", {
    statement: "Vaccinators should record every dose given.", kind: "good-practice-statement",
    direction: "for" }, quoted("Vaccinators should record every dose given.")),
  n(NOREC, "recommendation", "No recommendation", {
    statement: "No recommendation can be made on a booster dose.", kind: "no-recommendation" },
    quoted("No recommendation can be made on a booster dose.")),
], [
  e("appearsIn", CITATION, DMN_FILE),
  e("hasSupplement", GL, ANNEX),
  e("contains", GL, SEC),
  e("contains", SEC, SUBSEC, { qualifier: "subsection" }),
  e("contains", SUBSEC, REC),
  e("contains", SUBSEC, GPS),
  e("contains", SUBSEC, NOREC),
  e("answers", REC, KQ),
  e("answers", NOREC, KQ),
  e("aboutIntervention", KQ, HI),
  e("addresses", EVID, KQ),
  e("reportedIn", EVID, ANNEX),
  e("supportedBy", REC, EVID),
  e("recommends", REC, HI),
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

const DSL = `${NS}/decision-support-logic/ex-d2`;
const PLANDEF = `${NS}/PlanDefinition/EXD2DTExample`;
const LIB = `${NS}/Library/EXD2DTExampleLogic`;

const L3 = doc("l3", [
  n(DSL, "decision-support-logic", "EX.D2", { id: "EX.D2", sourceKind: "url", source: "fixture" }),
  n(PLANDEF, "plan-definition", "EX.D2.DT.Example", {
    canonical: PLANDEF, resourceType: "PlanDefinition",
    // Read off the artefact, never asserted by the ontology: smart-base defines SG* profiles, the
    // published SOP names CRMI/CPG, and the immunizations IG uses CPG exclusively.
    profile: "http://hl7.org/fhir/uv/cpg/StructureDefinition/cpg-recommendationdefinition",
    status: "draft", version: "0.1.0", title: "EX.D2.DT.Example", name: "EXD2DTExample",
    publisher: "World Health Organization (WHO)", experimental: false }),
  n(LIB, "library", "EXD2DTExampleLogic", {
    canonical: LIB, resourceType: "Library", status: "draft", version: "0.1.0",
    name: "EXD2DTExampleLogic", publisher: "World Health Organization (WHO)" }),
], [
  e("implementedBy", DSL, PLANDEF, {
    properties: { resolutionStatus: "unresolved", extractionRule: "title == L2 decision table id",
                  targetPath: "PlanDefinition.action[0]" },
    ...inferred("matched by the SOP id convention; no back-pointer extension exists in the estate"),
  }),
  e("uses", PLANDEF, LIB),
  e("citesSource", PLANDEF, CITATION, {
    properties: { text: "Example guideline (1)" },
    evidence: { location: "fixture#relatedArtifact", quote: "Example guideline (1)" },
  }),
]);

const ALL = [L1, L2, L2_BPMN, L2_DMN, L3];

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
const byId = (d, id) => d.nodes.find((x) => x.id === id);

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

  // --- L1 normative content: value sets and GRADE ------------------------------------------------
  ["a strength outside the value set is rejected", L1, (d) => {
    byId(d, REC).properties.strength = "Strong";
  }, /not a code in value set "recommendation-strength"/],
  ["a publication type outside the value set is rejected", L1, (d) => {
    byId(d, GL).properties.publicationType = "guideline";
  }, /not a code in value set "publication-type"/],
  ["an invented resolutionStatus on a citation node is rejected", L1, (d) => {
    find(d, "citation").properties.resolutionStatus = "probably";
  }, /not a code in value set "resolution-status"/],
  ["a direction without a strength is rejected", L1, (d) => {
    delete byId(d, REC).properties.strength;
  }, /carries direction without strength/],
  ["a graded recommendation with neither direction nor strength is rejected", L1, (d) => {
    delete byId(d, REC).properties.strength; delete byId(d, REC).properties.direction;
  }, /graded -- and carries no direction or strength/],
  ["a good practice statement carrying a strength is rejected", L1, (d) => {
    byId(d, GPS).properties.strength = "strong";
  }, /A good practice statement is ungraded/],
  ["a no-recommendation carrying a direction is rejected", L1, (d) => {
    byId(d, NOREC).properties.direction = "against";
  }, /No recommendation was made/],
  ["PICO is no longer hung off the recommendation", L1, (d) => {
    d.nodes.push(n(`${KQ}/comparator`, "comparator", "no vaccination", { description: "no vaccination" }));
  }, /does not declare/],
  ["evidence does not answer a key question; a recommendation does", L1, (d) => {
    d.edges.push(e("answers", EVID, KQ));
  }, /is not licensed by the ontology/],
  ["certainty on a recommendation is overallCertainty, not certainty", L1, (d) => {
    byId(d, REC).properties.certainty = "moderate";
  }, /does not declare/],
  ["a good practice statement with a direction and no strength is not a finding", L1, null, null],

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

  // --- L3: the thin index ------------------------------------------------------------------------
  ["an unlicensed L3 edge is rejected", L3, (d) => {
    // A Library does not implement a decision-support-logic component; a PlanDefinition does.
    d.edges.push(e("implementedBy", find(d, "library").id, find(d, "plan-definition").id));
  }, /is not licensed by the ontology/],
  ["an L3 class may not reach a persona", L3, (d) => {
    d.edges.push(e("uses", find(d, "plan-definition").id, PERSONA));
  }, /is not licensed by the ontology/],
  ["a convention-matched implementedBy claiming resolution needs evidence", L3, (d) => {
    const x = findEdge(d, "implementedBy");
    x.properties.resolutionStatus = "resolved";
    delete x.evidence;
  }, /points at no evidence|carries no evidence/],
  ["an undeclared property on an L3 node is rejected", L3, (d) => {
    find(d, "plan-definition").properties.actionCount = 3;
  }, /does not declare/],
  ["an unresolved implementedBy is a legitimate state", L3, null, null],
  ["the L3 index conforms, and cites L1 across documents", L3, null, null],
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
