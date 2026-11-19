#!/usr/bin/env node
// Extracts the interior of a DMN file as the l2-dmn subgraph.
//
// Separate from the BPMN subgraph, and importing it, because the dependency is real and runs one
// way: dmn:usingTask names the BPMN task that invokes the decision. A DMN can be read without a
// BPMN -- the join is then recorded unresolved -- but the reference only exists in this direction.
//
// Two joins leave this subgraph. `reads` reaches an l2:data-element by a name recovered from prose.
// `citesSource` reaches an l1:citation minted from the same string by extract-citations.mjs, which
// is how the DMN interior and the L1 recommendation graph meet without either knowing the other.
//
//   node tools/extract-dmn.mjs <file.dmn> [--bpmn <f.bpmn>] [--out <path>]

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { sha256, dakNamespace, artifactId, elementId, citationId, dataElementId, normalisedScheme } from "./kgid.mjs";
import { extract as extractBpmn } from "./extract-bpmn.mjs";
import { ontologyVersion } from "./ontology.mjs";

const SKILL = "kg/extract-dmn";
const dec = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
                            .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const attr = (tag, name) => { const m = new RegExp(`${name}="([^"]*)"`).exec(tag); return m ? dec(m[1]) : null; };
const inner = (block, tag) => {
  const m = new RegExp(`<[a-z]+:${tag}>([\\s\\S]*?)</[a-z]+:${tag}>`).exec(block);
  return m ? dec(m[1].trim()) : null;
};
const node = (id, type, label, properties, extra = {}) =>
  ({ id, type, label, properties, derivation: "derived", skill: SKILL, ...extra });
const edge = (predicate, source, target, extra = {}) =>
  ({ type: "Statement", predicate, source, target, derivation: "derived", skill: SKILL, ...extra });

// A quoted token in an input expression is a FIELD or a VALUE depending on which side of a
// comparison it sits: in `where "Vaccine type" = "BCG vaccines"` the first is a field and the
// second is not. Taking every quoted token would invent a data element called "BCG vaccines".
const CMP = "=|≠|!=|<>|≤|≥|<=|>=|<|>";

export function dataElementsIn(expression) {
  const expr = String(expression ?? "").trim();
  if (!expr) return [];
  const quoted = [...expr.matchAll(/"([^"]+)"/g)];
  if (quoted.length === 0) {
    if (new RegExp(CMP).test(expr)) return [];
    return [{ name: expr, extractionRule: "bare-expression" }];
  }
  const out = [];
  for (const m of quoted) {
    const before = expr.slice(0, m.index).trimEnd();
    const after = expr.slice(m.index + m[0].length).trimStart();
    const pre = new RegExp(`(${CMP})$`).test(before);
    const post = new RegExp(`^(${CMP})`).test(after);
    if (pre && !post) continue;
    out.push({ name: dec(m[1]).trim(), extractionRule: post ? "quoted-left-of-comparison" : "quoted-operand" });
  }
  const seen = new Set();
  return out.filter((d) => d.name && !seen.has(d.name) && seen.add(d.name));
}

export function extract(xml, path, bpmn = null) {
  const rawNs = attr(xml, "namespace");
  const ns = dakNamespace(rawNs);
  const fileId = /<dmn:decision\b[^>]*\sid="([^"]+)"/.exec(xml)?.[1] ?? basename(path);
  const fileIri = artifactId(ns, fileId);
  const eid = (id) => elementId(ns, fileId, id);

  const nodes = [];
  const edges = [];
  const warnings = [];
  if (normalisedScheme(rawNs)) {
    warnings.push(`namespace "${rawNs}" uses http; dak.json declares https. Normalised to "${ns}".`);
  }

  nodes.push(node(fileIri, "dmn-definitions", attr(xml, "label") ?? fileId, {
    id: fileId, namespace: attr(xml, "namespace"), label: attr(xml, "label"),
    source: path, sha256: sha256(readFileSync(path)),
  }));

  for (const [, decTag, decBody] of xml.matchAll(/<dmn:decision\b([^>]*)>([\s\S]*?)<\/dmn:decision>/g)) {
    const decId = attr(decTag, "id");
    const decIri = eid(decId);
    nodes.push(node(decIri, "dmn-decision", attr(decTag, "label") ?? decId, {
      id: decId, label: attr(decTag, "label"), question: inner(decBody, "question"),
      allowedAnswers: inner(decBody, "allowedAnswers"),
    }));
    edges.push(edge("contains", fileIri, decIri));

    // --- the BPMN join --------------------------------------------------------------------------
    const usingTask = /<dmn:usingTask\b[^>]*href="([^"]+)"/.exec(decBody)?.[1] ?? null;
    if (usingTask) {
      const [href, frag] = usingTask.split("#");
      const taskName = frag ? decodeURIComponent(frag) : null;
      const hit = taskName && bpmn ? bpmn.stats.taskNames.get(taskName) : undefined;
      let target = hit;
      if (!target) {
        target = `${ns}/artifact/${basename(href)}${frag ? `#${frag}` : ""}`;
        nodes.push(node(target, "external-artifact", taskName ?? href,
          { iri: target, targetKind: "bpmn" }, {
            derivation: "inferred",
            note: "The task named by this href is in a BPMN file this graph does not hold, so it " +
                  "is an opaque pointer. Nothing is claimed about the task itself.",
            evidence: { location: path, quote: `<dmn:usingTask href="${usingTask}"/>` },
          }));
        warnings.push(`usingTask -> BPMN task unresolved: ${bpmn ? "no task of that name in the BPMN read" : "no BPMN supplied"}`);
      }
      edges.push(edge("invokedBy", decIri, target, {
        properties: {
          resolutionStatus: hit ? "resolved" : "unresolved",
          matchedOn: "usingTask @href fragment == BPMN task @name",
          href: usingTask, taskName,
        },
        derivation: "inferred",
        note: hit
          ? "Matched on the task's NAME, URL-encoded in the href fragment — not on its id. It " +
            "holds only while that sentence stays byte-identical in the BPMN."
          : "The href names a BPMN file and a task by name. Nothing was available to resolve it " +
            "against, so the target is an opaque pointer and the edge is explicitly unresolved.",
        evidence: { location: path, quote: `<dmn:usingTask href="${usingTask}"/>` },
      }));
    }

    for (const [, tblTag, tblBody] of decBody.matchAll(/<dmn:decisionTable\b([^>]*)>([\s\S]*?)<\/dmn:decisionTable>/g)) {
      const tblId = attr(tblTag, "id") ?? `${decId}.table`;
      const tblIri = eid(`${tblId}#table`);
      nodes.push(node(tblIri, "dmn-decision-table", attr(tblTag, "label") ?? tblId, {
        id: tblId,
        // Absent in the BCG table. Recorded as null rather than defaulted to DMN's UNIQUE, which
        // would be asserting something the file does not say.
        hitPolicy: attr(tblTag, "hitPolicy"), aggregation: attr(tblTag, "aggregation"),
      }));
      edges.push(edge("contains", decIri, tblIri));

      const inputs = [...tblBody.matchAll(/<dmn:input\b([^>]*)>([\s\S]*?)<\/dmn:input>/g)]
        .map(([, tag, body], i) => ({
          id: attr(tag, "id"), label: attr(tag, "label"), ordinal: i,
          expression: inner(body, "text"),
          typeRef: /<dmn:inputExpression\b[^>]*typeRef="([^"]+)"/.exec(body)?.[1] ?? null,
        }));
      const outputs = [...tblBody.matchAll(/<dmn:output\b([^>]*)>([\s\S]*?)<\/dmn:output>/g)]
        .map(([, tag, body], i) => ({
          id: attr(tag, "id"), label: attr(tag, "label"), ordinal: i,
          description: inner(body, "description"),
        }));

      // DMN splits the output columns across outputEntry and annotationEntry, positionally. How
      // many are which is read from a rule rather than assumed, because the split decides which
      // column a cell belongs to and getting it wrong silently misattributes every citation.
      const firstRule = /<dmn:rule\b[^>]*>([\s\S]*?)<\/dmn:rule>/.exec(tblBody)?.[1] ?? "";
      const nOutputEntry = (firstRule.match(/<dmn:outputEntry>/g) ?? []).length;
      const refCol = outputs.findIndex((o) => /source content \(L1\)/i.test(o.description ?? "")
                                           || /^reference/i.test(o.label ?? ""));

      const seenElements = new Set();
      for (const c of inputs) {
        const iri = eid(c.id);
        nodes.push(node(iri, "dmn-input-clause", c.label, {
          id: c.id, label: c.label, expression: c.expression, typeRef: c.typeRef, ordinal: c.ordinal,
        }));
        edges.push(edge("contains", tblIri, iri));

        for (const d of dataElementsIn(c.expression)) {
          const deIri = dataElementId(ns, d.name);
          if (!seenElements.has(deIri)) {
            seenElements.add(deIri);
            nodes.push(node(deIri, "data-element", d.name, {
              name: d.name, extractionRule: d.extractionRule, resolutionStatus: "unresolved",
            }, {
              derivation: "inferred",
              note: `Recovered from a DMN input expression by the "${d.extractionRule}" rule. No ` +
                    `data dictionary was available, so this is a name that was referenced, not a ` +
                    `definition that was found — and no type or canonical is claimed.`,
              evidence: { location: `${path}#${c.id}`, quote: c.expression },
            }));
          }
          edges.push(edge("reads", iri, deIri, {
            properties: { resolutionStatus: "unresolved", extractionRule: d.extractionRule },
            derivation: "inferred",
            note: "The element name was read out of free text. Until a dictionary resolves it, " +
                  "this records that the decision refers to something by that name.",
            evidence: { location: `${path}#${c.id}`, quote: c.expression },
          }));
        }
      }

      for (const c of outputs) {
        const iri = eid(c.id);
        nodes.push(node(iri, "dmn-output-clause", c.label, {
          id: c.id, label: c.label, description: c.description, ordinal: c.ordinal,
          serialisedAs: c.ordinal < nOutputEntry ? "outputEntry" : "annotationEntry",
          isReferenceColumn: c.ordinal === refCol,
        }));
        edges.push(edge("contains", tblIri, iri));
      }

      const refAnnotationIndex = refCol === -1 ? -1 : refCol - nOutputEntry;
      const cov = { rules: 0, cited: 0, noAnnotations: 0 };
      let ordinal = 0;
      for (const [, ruleId, body] of tblBody.matchAll(/<dmn:rule\b[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/dmn:rule>/g)) {
        cov.rules++;
        const cells = (t) => [...body.matchAll(new RegExp(`<dmn:${t}>([\\s\\S]*?)</dmn:${t}>`, "g"))]
          .map((m) => ({ description: inner(m[1], "description"), text: inner(m[1], "text") }));
        const conditions = cells("inputEntry").map((c, i) => ({ clause: inputs[i]?.label ?? null, ...c }));
        const results = cells("outputEntry").map((c, i) => ({ clause: outputs[i]?.label ?? null, ...c }));
        const annotations = cells("annotationEntry")
          .map((c, i) => ({ clause: outputs[i + nOutputEntry]?.label ?? null, text: c.text ?? c.description }));
        if (!annotations.length) cov.noAnnotations++;

        const iri = eid(ruleId);
        nodes.push(node(iri, "dmn-rule", `rule ${ordinal + 1}`, {
          id: ruleId, ordinal, conditions, outputs: results, annotations,
        }));
        edges.push(edge("contains", tblIri, iri));
        ordinal++;

        const citationText = refAnnotationIndex >= 0 ? annotations[refAnnotationIndex]?.text : null;
        if (citationText && citationText !== "–" && citationText !== "-") {
          cov.cited++;
          edges.push(edge("citesSource", iri, citationId(ns, citationText), {
            properties: { text: citationText },
            note: "Target is an l1:citation minted by tools/extract-citations.mjs from this same " +
                  "string, so the DMN interior and the L1 graph join without either knowing the other.",
            evidence: { location: `${path}#${ruleId}`, quote: citationText },
          }));
        }
      }
      if (cov.cited < cov.rules) {
        warnings.push(`L1 citation coverage ${cov.cited}/${cov.rules} rules ` +
                      `(${cov.noAnnotations} carry no annotation at all)`);
      }
    }
  }

  return {
    doc: {
      "@context": "http://smart.who.int/kg/l2-dmn.context.jsonld",
      id: `${ns}/kg/l2-dmn`, type: "Entity", ontologyVersion: ontologyVersion(),
      generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      wasDerivedFrom: [{ path, sha256: sha256(readFileSync(path)) }],
      nodes, edges,
    },
    stats: { warnings },
  };
}

function main() {
  const arg = (f) => { const i = process.argv.indexOf(f); return i === -1 ? null : process.argv[i + 1]; };
  const path = process.argv[2];
  if (!path || path.startsWith("--")) {
    console.error("usage: extract-dmn.mjs <file.dmn> [--bpmn <f.bpmn>] [--out <path>]");
    process.exit(2);
  }
  const bpmnPath = arg("--bpmn");
  const bpmn = bpmnPath ? extractBpmn(readFileSync(bpmnPath, "utf8"), bpmnPath) : null;
  const { doc, stats } = extract(readFileSync(path, "utf8"), path, bpmn);
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  else console.log(JSON.stringify(doc, null, 2));

  const by = {};
  for (const n of doc.nodes) by[n.type] = (by[n.type] ?? 0) + 1;
  console.error(`${doc.nodes.length} nodes, ${doc.edges.length} edges`);
  console.error(Object.entries(by).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
  for (const w of stats.warnings) console.error(`  warning: ${w}`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
