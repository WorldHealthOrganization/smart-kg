#!/usr/bin/env node
// Extracts L1 citations from a DMN decision table.
//
// This is the whole point of the L1 graph, in 150 lines. WHO's own tooling already provides for an
// L1 reference per decision-table rule -- the BCG table declares an output column whose description
// reads "Reference for the source content (L1)" -- but it holds free text that no tool can follow,
// and only 1 of that table's 25 rules has one filled in. This turns each such string into a
// `citation` node, leaves it `unresolved` until a person resolves it, and reports how many rules had
// nothing to extract. A cell holding several citations on separate lines yields one node per line,
// and "[Add appropriate reference]" is recorded as a placeholder: the author saying a source is
// missing, which coverage counts apart from a blank.
//
// The output is an L2 document: the citations are L1 nodes, but the file they appear in is the DAK's
// (l2:external-artifact), and since L1 3.0 nothing in L1 points out of L1.
//
// What it does NOT do is guess the resolution. Matching "WHO recommendations for routine
// immunization - summary tables (March 2023) (1)" to a publication is a judgement, and the schema
// requires a note and evidence for a judgement. An extractor that resolved silently would be
// manufacturing provenance.
//
//   node tools/extract-citations.mjs <file.dmn> [--out /tmp/citations.json]

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { sha256, dakNamespace, artifactId, citationId, normalisedScheme } from "./kgid.mjs";
import { ontologyVersion } from "./ontology.mjs";

const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = (block, tag) => {
  const m = new RegExp(`<dmn:${tag}>([\\s\\S]*?)</dmn:${tag}>`).exec(block);
  return m ? dec(m[1].trim()) : null;
};

export function extract(xml, path) {
  const nsUrl = dakNamespace(/namespace="([^"]+)"/.exec(xml)?.[1]);   // scheme-normalised; see kgid.mjs
  const tableId = /<dmn:decision id="([^"]+)"/.exec(xml)?.[1] ?? basename(path);
  const usingTask = /<dmn:usingTask href="([^"]+)"/.exec(xml)?.[1] ?? null;

  // Which output column is the L1 reference. The description is the reliable marker; column order
  // is not, and hard-coding an index would break on the first table that adds a column.
  const outputs = [...xml.matchAll(/<dmn:output id="([^"]+)" label="([^"]+)">([\s\S]*?)<\/dmn:output>/g)]
    .map(([, id, label, body]) => ({ id, label: dec(label), description: text(body, "description") }));
  const refCol = outputs.findIndex((o) => /source content \(L1\)/i.test(o.description ?? "")
                                       || /^reference/i.test(o.label));
  // outputEntry and annotationEntry are serialised separately; the reference lands among the
  // annotations, offset by however many outputs are carried as outputEntry. In the BCG table the
  // first two outputs (Care Plan, Guidance) are outputEntry and the last two (Annotations,
  // Reference(s)) are annotationEntry, which is what the offset of 2 encodes.
  const refAnnotationIndex = refCol === -1 ? -1 : refCol - 2;

  const nodes = [];
  const edges = [];
  const seenCitations = new Map();

  const artifact = artifactId(nsUrl, tableId);
  nodes.push({
    id: artifact,
    type: "external-artifact",
    label: /label="([^"]+)"/.exec(xml)?.[1] ?? tableId,
    properties: { iri: artifact, targetKind: "dmn" },
    derivation: "derived",
    skill: "kg/extract-citations",
  });

  // Coverage, counted rather than assumed. A decision table's L1 column is a column, not a
  // guarantee that anyone filled it in: in the BCG table 16 of 25 rules carry no annotation at all
  // and 8 carry only the first (guidance) one. Which rules cite a source and which do not is
  // precisely the question this graph exists to make answerable, so the extractor reports it
  // instead of quietly emitting whatever it found.
  const cov = { rules: 0, cited: 0, placeholderOnly: 0, noAnnotations: 0, shortOfRefColumn: 0 };

  for (const [, ruleId, body] of xml.matchAll(/<dmn:rule id="([^"]+)">([\s\S]*?)<\/dmn:rule>/g)) {
    cov.rules++;
    const annotations = [...body.matchAll(/<dmn:annotationEntry>([\s\S]*?)<\/dmn:annotationEntry>/g)]
      .map((m) => text(m[1] + "", "text") ?? dec(m[1].replace(/<[^>]+>/g, "").trim()));
    if (annotations.length === 0) cov.noAnnotations++;
    if (refAnnotationIndex < 0 || annotations.length <= refAnnotationIndex) {
      // Trailing empty annotation columns are omitted by the generator rather than serialised
      // empty, so a rule can be short of the reference column. Positional reading cannot tell a
      // rule that omitted only the reference from one that omitted an earlier column too; it is
      // counted here rather than guessed at.
      if (annotations.length > 0) cov.shortOfRefColumn++;
      continue;
    }
    const cell = annotations[refAnnotationIndex];
    // One citation per line: a cell can cite the summary tables and a position paper at once, and
    // those resolve to different publications.
    const lines = (cell ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "–" && l !== "-");
    if (!lines.length) continue;
    if (lines.some((l) => !/^\[.*\]$/.test(l))) cov.cited++;
    else cov.placeholderOnly++;

    for (const citationText of lines) {
      // One citation node per distinct string; many rules cite the same source, and minting a node
      // per rule would inflate the graph and hide the fact that they are one reference. Where each
      // rule cites it is recorded by L2-DMN's citesSource edges, not on the node -- a location
      // property could only ever hold the first rule.
      if (seenCitations.has(citationText)) continue;
      const citeId = citationId(nsUrl, citationText);
      seenCitations.set(citationText, citeId);
      const numbering = /\((\d+)\)\s*$/.exec(citationText)?.[1] ?? null;
      const placeholder = /^\[.*\]$/.test(citationText);
      nodes.push({
        id: citeId,
        type: "citation",
        label: citationText.length > 80 ? citationText.slice(0, 77) + "..." : citationText,
        properties: {
          text: citationText,
          ...(numbering ? { numbering } : {}),
          citationKind: placeholder ? "placeholder" : "reference",
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
        target: artifact,
        derivation: "derived",
        skill: "kg/extract-citations",
      });
    }
  }

  return {
    doc: {
      "@context": "http://smart.who.int/kg/l2.context.jsonld",
      id: `${nsUrl}/kg/citations`,
      type: "Entity",
      ontologyVersion: ontologyVersion(),
      generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      wasDerivedFrom: [{ path, sha256: sha256(readFileSync(path)) }],
      nodes,
      edges,
    },
    stats: { ...cov, citations: seenCitations.size, usingTask },
  };
}

const path = process.argv[2];
if (!path) { console.error("usage: extract-citations.mjs <file.dmn> [--out <path>]"); process.exit(2); }
const { doc, stats } = extract(readFileSync(path, "utf8"), path);
const outIdx = process.argv.indexOf("--out");
if (outIdx !== -1) writeFileSync(process.argv[outIdx + 1], JSON.stringify(doc, null, 2) + "\n");
console.error(`${stats.rules} rules, ${stats.citations} distinct L1 citation(s), ` +
              `${doc.nodes.length} nodes, ${doc.edges.length} edges`);
console.error(`coverage: ${stats.cited}/${stats.rules} rules cite an L1 source` +
              (stats.placeholderOnly ? `, ${stats.placeholderOnly} carry only a placeholder` : "") + ` ` +
              `(${stats.noAnnotations} carry no annotation at all` +
              (stats.shortOfRefColumn ? `, ${stats.shortOfRefColumn} stop short of the reference column` : "") +
              `)`);
if (stats.cited < stats.rules) {
  console.error("  ^ a gap in the source, not in this tool. Reported so it can be fixed upstream.");
}
if (stats.usingTask) console.error(`bpmn link present: ${decodeURIComponent(stats.usingTask).slice(0, 100)}...`);
if (outIdx === -1) console.log(JSON.stringify(doc, null, 2));
