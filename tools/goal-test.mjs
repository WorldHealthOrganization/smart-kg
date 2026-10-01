#!/usr/bin/env node
// L1's three goals, run as tests. docs/SCOPE.md says L1 exists for impact analysis, coverage and
// citation resolution; this proves the model can still answer each, against the smallest documents
// that exercise them. Every document is first checked by tools/validate.mjs, so a goal can only
// pass on a graph the model accepts.
//
// Built in code rather than committed, for the reason docs/STORAGE.md gives. The wording quoted is
// from the WHO publications the model was checked against; identifiers that could not be verified
// are marked example/.
//
// When an evaluation criterion for L1 is agreed, it becomes a case here.
//
//   node tools/goal-test.mjs

import { validateGraph, layerOf } from "./validate.mjs";
import { loadLayer, ontologyVersion } from "./ontology.mjs";
import { graphOf, impact, coverage, resolveCitation } from "./l1-queries.mjs";
import { citationId, referenceEntryId, publicationId, recommendationId, publicationElementId,
         evidenceId, outcomeId, keyQuestionId, contentHash, contentText, artifactId } from "./kgid.mjs";

const VERSION = ontologyVersion();
const NS = "https://example.org/dak";
const doc = (layer, nodes, edges) => ({
  "@context": `http://smart.who.int/kg/${layer}.context.jsonld`, id: `${NS}/kg/${layer}`, type: "Entity",
  ontologyVersion: VERSION, generatedAt: "2026-10-01T00:00:00Z", nodes, edges,
});
const pdf = (where, q) => ({ derivation: "inferred", note: "read from the PDF", evidence: { location: where, quote: q } });
const node = (id, type, properties, extra = { derivation: "derived" }) => ({ id, type, label: id.split("/").pop(), properties, ...extra });
const edge = (predicate, source, target, extra = { derivation: "derived" }) =>
  ({ type: "Statement", predicate, source, target, ...extra });
const ie = (predicate, source, target) => edge(predicate, source, target, pdf("fixture", "…"));
const hashed = (props, fields) => ({ ...props, contentHash: contentHash(contentText({ properties: props }, fields)) });

// ---- impact: ANC A.2.1 supersedes a 2012 recommendation ------------------------------------------
const ANC = publicationId([{ type: "isbn", value: "978-92-4-154991-2" }]);
const IFA2012 = publicationId([{ type: "iris-handle", value: "example/daily-ifa-2012" }]);
const A21 = recommendationId(ANC, "A.2.1");
const OLD = recommendationId(IFA2012, "1");
const ROW = publicationElementId(ANC, "Table 1", "row A.2.1");
const KQ = keyQuestionId(ANC, "A.2.1");
const ANAEMIA = outcomeId(ANC, "maternal anaemia");
const EV = evidenceId(ANC, "A.2.1", "maternal anaemia");
const DSL = `${NS}/decision-support-logic/anc-d1`;
const A21_TEXT = "Daily oral iron and folic acid supplementation with 30 mg to 60 mg of elemental iron and 400 µg " +
  "(0.4 mg) of folic acid is recommended for pregnant women to prevent maternal anaemia, puerperal sepsis, low " +
  "birth weight, and preterm birth.";

const l1Impact = doc("l1", [
  node(ANC, "publication", { title: "WHO recommendations on antenatal care for a positive pregnancy experience",
    identifiers: [{ type: "isbn", value: "978-92-4-154991-2" }], publicationType: "standard-guideline",
    grcStatus: "approved" }, pdf("anc.pdf p. ii", "ISBN 978 92 4 154991 2")),
  node(IFA2012, "publication", { title: "Guideline: daily iron and folic acid supplementation in pregnant women",
    issued: "2012", identifiers: [{ type: "iris-handle", value: "example/daily-ifa-2012" }],
    publicationType: "standard-guideline", grcStatus: "approved" }, pdf("anc.pdf p. xi, footnote d", "Guideline: daily iron and folic acid supplementation in pregnant women (2012)")),
  node(A21, "recommendation", hashed({ identifier: "A.2.1", statement: A21_TEXT, kind: "recommendation",
    direction: "for", status: "current" }, ["statement"]), pdf("anc.pdf p. xi", "A.2.1: Daily oral iron…")),
  node(OLD, "recommendation", hashed({ statement: "(2012 wording not reproduced in this fixture)",
    kind: "recommendation", status: "superseded" }, ["statement"]), pdf("fixture", "…")),
  node(ROW, "publication-element", { elementType: "table-row", rowType: "data", ordinal: 6,
    cells: ["Iron and folic acid supplements", null, null] }, pdf("anc.pdf p. xi", "Iron and folic acid supplements")),
  node(KQ, "key-question", hashed({ identifier: "A.2.1", text: "For pregnant women (P), does daily iron " +
    "supplementation (I) (with or without folic acid) compared with no iron supplementation or placebo (C), " +
    "improve maternal and perinatal outcomes (O)?" }, ["text"]), pdf("anc-web-annexes.pdf p. 1", "A.2.1: For pregnant women (P)…")),
  node(ANAEMIA, "outcome", { name: "maternal anaemia", importance: "critical", category: "Maternal morbidity" },
    pdf("anc-web-annexes.pdf p. 1", "Maternal morbidity (infections, anaemia)")),
  node(EV, "evidence", hashed({ evidenceType: "effect", summary: "(evidence summary for maternal anaemia)" }, ["summary"]),
    pdf("fixture", "…")),
], [
  ie("definedIn", A21, ANC), ie("definedIn", OLD, IFA2012), ie("supersedes", A21, OLD),
  ie("presentedIn", A21, ROW), { ...ie("contains", ANC, ROW), qualifier: "unsectioned" },
  ie("answers", A21, KQ), ie("definedIn", KQ, ANC), ie("hasOutcome", KQ, ANAEMIA), ie("definedIn", ANAEMIA, ANC),
  ie("addresses", EV, KQ), ie("forOutcome", EV, ANAEMIA), ie("definedIn", EV, ANC), ie("supportedBy", A21, EV),
]);
const l2Impact = doc("l2", [
  node(DSL, "decision-support-logic", { id: "ANC.D1", sourceKind: "url", source: "fixture" }),
], [
  edge("implementedBy", A21, DSL, pdf("fixture", "decision table cites A.2.1")),
]);

// ---- coverage and citation resolution: the immunization DAK's BCG table --------------------------
const WORKBOOK = artifactId(NS, "IMMZ-DAK-decision-support-logic.xlsx");
const DMN = artifactId(NS, "DAK.DT.IMMZ.D2.DT.BCG");
const CITE_TEXT = "WHO recommendations for routine immunization – summary tables (March 2023) (1)";
const CITE = citationId(NS, CITE_TEXT);
const PLACE = citationId(NS, "[Add appropriate reference]");
const ENTRY = referenceEntryId(WORKBOOK, 1);
// Published only on the web, so its address is its identifier (IMMZ DAK 2024, reference 29).
const SUMMARY_URL = "https://www.who.int/teams/immunization-vaccines-and-biologicals/policies/" +
  "who-recommendations-for-routine-immunization---summary-tables";
const SUMMARY = publicationId([{ type: "url", value: SUMMARY_URL }]);
const rule = (i) => `${DMN}#Rule_${i}`;

const l1Cite = doc("l1", [
  node(CITE, "citation", { text: CITE_TEXT, numbering: "1", citationKind: "reference", resolutionStatus: "resolved" }),
  node(PLACE, "citation", { text: "[Add appropriate reference]", citationKind: "placeholder", resolutionStatus: "unresolved" }),
  node(ENTRY, "reference-entry", { number: "1", resolutionStatus: "resolved",
    text: "WHO recommendations for routine immunization – summary tables (updated March 2023), Geneva: World Health Organization; 2023 (…)" }),
  node(SUMMARY, "publication", { title: "WHO recommendations for routine immunization – summary tables",
    issued: "2023-03", identifiers: [{ type: "url", value: SUMMARY_URL }],
    publicationType: "summary-table" }, pdf("IMMZ decision-support logic.xlsx, References!A2", "WHO recommendations for routine immunization – summary tables (updated March 2023)")),
], [
  edge("numberedAs", CITE, ENTRY),
  edge("resolvesTo", ENTRY, SUMMARY, pdf("IMMZ decision-support logic.xlsx, References!B2", "…summary tables (updated March 2023)…")),
]);
const l2Cite = doc("l2", [
  node(WORKBOOK, "external-artifact", { iri: WORKBOOK, targetKind: "spreadsheet" }),
], [edge("appearsIn", CITE, WORKBOOK)]);
const l2dmnCite = doc("l2-dmn", [
  node(DMN, "dmn-definitions", { id: "DAK.DT.IMMZ.D2.DT.BCG", source: "fixture", sha256: "0".repeat(64) }),
  node(rule(1), "dmn-rule", { id: "Rule_1", ordinal: 0 }),
  node(rule(2), "dmn-rule", { id: "Rule_2", ordinal: 1 }),
  node(rule(3), "dmn-rule", { id: "Rule_3", ordinal: 2 }),
], [
  edge("citesSource", rule(1), CITE, { derivation: "derived", properties: { text: CITE_TEXT } }),
  edge("citesSource", rule(2), PLACE, { derivation: "derived", properties: { text: "[Add appropriate reference]" } }),
]);

// ---- run -------------------------------------------------------------------------------------------
const docs = [l1Impact, l2Impact, l1Cite, l2Cite, l2dmnCite];
let failures = 0;
const index = new Map(docs.flatMap((d) => d.nodes.map((n) => [n.id, n])));
for (const d of docs) {
  const { errors } = validateGraph(d, loadLayer(layerOf(d)), index);
  if (errors.length) { console.error(`FAIL  fixture ${d.id} does not validate: ${errors[0]}`); failures++; }
}
const g = graphOf(docs);
const check = (name, ok, detail) => {
  if (ok) console.log(`ok    ${name}`);
  else { console.error(`FAIL  ${name}\n      ${detail}`); failures++; }
};

const imp = impact(g, OLD);
check("impact: a superseded recommendation reaches its replacement", imp.supersededBy.includes(A21),
      JSON.stringify(imp.supersededBy));
check("impact: …and where the replacement is printed", imp.presentedIn.includes(ROW), JSON.stringify(imp.presentedIn));
check("impact: …and the evidence and outcomes it rests on", imp.evidence.includes(EV) && imp.outcomes.includes(ANAEMIA),
      JSON.stringify({ evidence: imp.evidence, outcomes: imp.outcomes }));
check("impact: …and the DAK artefact implementing it", imp.implementedBy.includes(DSL), JSON.stringify(imp.implementedBy));

const cov = coverage(g);
check("coverage: the superseded recommendation is the one with no DAK representation",
      cov.unrepresented.length === 1 && cov.unrepresented[0] === OLD, JSON.stringify(cov.unrepresented));
check("coverage: DMN rules are counted cited / placeholder / none",
      cov.rules.cited.length === 1 && cov.rules.placeholder.length === 1 && cov.rules.none.length === 1,
      JSON.stringify(cov.rules));

const res = resolveCitation(g, CITE);
check("citation resolution: the string reaches the publication through its reference entry",
      res.target === SUMMARY && res.steps.map((s) => s.predicate).join(">") === "numberedAs>resolvesTo",
      JSON.stringify(res));
check("citation resolution: the mechanical step and the judgement are told apart",
      res.steps[0]?.derivation === "derived" && res.steps[1]?.derivation === "inferred", JSON.stringify(res.steps));
check("citation resolution: a placeholder leads nowhere", resolveCitation(g, PLACE).target === null,
      JSON.stringify(resolveCitation(g, PLACE)));

console.log(failures ? `\n${failures} goal test(s) fail` : "\nall goal tests pass");
process.exit(failures ? 1 : 0);
