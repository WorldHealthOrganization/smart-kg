#!/usr/bin/env node
// Extracts L1 citations from a DMN decision table into L1 graph nodes.
//
// This is the whole point of the L1 graph, in 120 lines. WHO's own tooling already emits an L1
// reference per decision-table rule -- the BCG table declares an output column whose description
// reads "Reference for the source content (L1)" -- but it emits it as free text that no tool can
// follow. This turns each of those strings into a `citation` node with a location, and leaves it
// `unresolved` until a person resolves it to a publication.
//
// What it does NOT do is guess the resolution. Matching "WHO recommendations for routine
// immunization - summary tables (March 2023) (1)" to a publication is a judgement, and the schema
// requires a note and evidence for a judgement. An extractor that resolved silently would be
// manufacturing provenance.
//
//   node tools/extract-citations.mjs <file.dmn> [--out examples/x.json]

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = (block, tag) => {
  const m = new RegExp(`<dmn:${tag}>([\\s\\S]*?)</dmn:${tag}>`).exec(block);
  return m ? dec(m[1].trim()) : null;
};

export function extract(xml, path) {
  const nsUrl = /namespace="([^"]+)"/.exec(xml)?.[1] ?? "urn:unknown";
  const tableId = /<dmn:decision id="([^"]+)"/.exec(xml)?.[1] ?? basename(path);
  const usingTask = /<dmn:usingTask href="([^"]+)"/.exec(xml)?.[1] ?? null;

  // Which output column is the L1 reference. The description is the reliable marker; column order
  // is not, and hard-coding an index would break on the first table that adds a column.
  const outputs = [...xml.matchAll(/<dmn:output id="([^"]+)" label="([^"]+)">([\s\S]*?)<\/dmn:output>/g)]
    .map(([, id, label, body]) => ({ id, label: dec(label), description: text(body, "description") }));
  const refCol = outputs.findIndex((o) => /source content \(L1\)/i.test(o.description ?? "")
                                       || /^reference/i.test(o.label));
  // outputEntry and annotationEntry are serialised separately; the reference lands among the
  // annotations, offset by however many outputs are carried as outputEntry.
  const nAnnotationCols = outputs.length - 2;
  const refAnnotationIndex = refCol === -1 ? -1 : refCol - 2;

  const nodes = [];
  const edges = [];
  const seenCitations = new Map();

  nodes.push({
    id: `${nsUrl}/artifact/${tableId}`,
    type: "external-artifact",
    label: /label="([^"]+)"/.exec(xml)?.[1] ?? tableId,
    properties: { iri: `${nsUrl}/artifact/${tableId}`, targetKind: "dmn:DecisionTable" },
    derivation: "derived",
    skill: "kg/extract-citations",
  });

  for (const [, ruleId, body] of xml.matchAll(/<dmn:rule id="([^"]+)">([\s\S]*?)<\/dmn:rule>/g)) {
    const annotations = [...body.matchAll(/<dmn:annotationEntry>([\s\S]*?)<\/dmn:annotationEntry>/g)]
      .map((m) => text(m[1] + "", "text") ?? dec(m[1].replace(/<[^>]+>/g, "").trim()));
    if (refAnnotationIndex < 0 || annotations.length <= refAnnotationIndex) continue;
    const citationText = annotations[refAnnotationIndex];
    if (!citationText || citationText === "–" || citationText === "-") continue;

    // One citation node per distinct string; many rules cite the same source, and minting a node
    // per rule would inflate the graph and hide the fact that they are one reference.
    let citeId = seenCitations.get(citationText);
    if (!citeId) {
      citeId = `${nsUrl}/citation/${sha256(Buffer.from(citationText)).slice(0, 12)}`;
      seenCitations.set(citationText, citeId);
      const numbering = /\((\d+)\)\s*$/.exec(citationText)?.[1] ?? null;
      nodes.push({
        id: citeId,
        type: "citation",
        label: citationText.length > 80 ? citationText.slice(0, 77) + "..." : citationText,
        properties: {
          text: citationText,
          location: `${path}#${ruleId}`,
          ...(numbering ? { numbering } : {}),
          resolutionStatus: "unresolved",
        },
        derivation: "derived",
        note: "Copied verbatim from the rule's L1 reference annotation. Resolution to a publication is deliberately not attempted here.",
        skill: "kg/extract-citations",
      });
      edges.push({
        type: "Statement",
        predicate: "appearsIn",
        source: citeId,
        target: `${nsUrl}/artifact/${tableId}`,
        derivation: "derived",
        skill: "kg/extract-citations",
      });
    }
  }

  return {
    doc: {
      "@context": "http://smart.who.int/kg/l1.context.jsonld",
      id: `${nsUrl}/kg/l1`,
      type: "Entity",
      ontologyVersion: "1.0",
      generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      wasDerivedFrom: [{ path, sha256: sha256(readFileSync(path)) }],
      nodes,
      edges,
    },
    stats: { rules: [...xml.matchAll(/<dmn:rule id=/g)].length, citations: seenCitations.size, usingTask },
  };
}

const path = process.argv[2];
if (!path) { console.error("usage: extract-citations.mjs <file.dmn> [--out <path>]"); process.exit(2); }
const { doc, stats } = extract(readFileSync(path, "utf8"), path);
const outIdx = process.argv.indexOf("--out");
if (outIdx !== -1) writeFileSync(process.argv[outIdx + 1], JSON.stringify(doc, null, 2) + "\n");
console.error(`${stats.rules} rules, ${stats.citations} distinct L1 citation(s), ` +
              `${doc.nodes.length} nodes, ${doc.edges.length} edges`);
if (stats.usingTask) console.error(`bpmn link present: ${decodeURIComponent(stats.usingTask).slice(0, 100)}...`);
if (outIdx === -1) console.log(JSON.stringify(doc, null, 2));
