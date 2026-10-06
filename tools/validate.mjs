#!/usr/bin/env node
// Checks a graph document against the ontology of its layer -- tier 2.
//
// Tier 1 is shape: does the document match shapes/recommendation-graph.schema.json. That is a JSON
// Schema question and CI answers it with ajv. This answers the question a JSON Schema cannot: are
// the node types classes the ontology declares, and is every edge a triple the ontology licenses.
// Inlining the licensing table into a schema would fork it; checking the ontology as data is the
// alternative, and this is it.
//
// A document names its layer through its @context (l1.context.jsonld, l2.context.jsonld). L2
// licenses edges onto L1 classes -- a decision rule cites an l1:citation -- so the L2 ontology is
// loaded with its imports resolved and the check runs against both.
//
// smart-skills `kg/validate-dak-graph` specifies this check as a contract. This is its reference
// implementation, and it is here rather than there because it needs no third-party validator --
// the ontology is the only input.
//
//   node tools/validate.mjs path/to/graph.json
//   node tools/validate.mjs l1.json l2.json bpmn.json     # references resolve across the set
//
// Plain Node, no dependencies.

import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLayer, scopeOf, bindingOf } from "./ontology.mjs";
import { contentHash, contentText, norm } from "./kgid.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LAYER = "l1";

/** Which ontology a document should be checked against. */
export function layerOf(doc) {
  const ctx = typeof doc["@context"] === "string" ? doc["@context"] : "";
  // Layer names are l1, l2, l2-bpmn, l2-dmn — the subgraph suffix is part of the name.
  const m = /\/(l\d+(?:-[a-z0-9]+)*)\.context\.jsonld$/.exec(ctx);
  return m ? m[1] : DEFAULT_LAYER;
}

/**
 * @returns {{errors: string[], warnings: string[], metrics: object}}
 */
/**
 * @param doc      the graph document to check
 * @param loaded   its layer, with imports resolved
 * @param external node ids defined in sibling documents of the same graph. A graph split across
 *                 documents is still one graph: an L2 decision rule cites an l1:citation that the
 *                 L1 document defines, and neither file is wrong for not containing the other.
 */
export function validateGraph(doc, loaded, external = new Map()) {
  const errors = [];
  const warnings = [];

  // The layer's own ontology, for the version check; its full scope including imports, for the
  // licensing check. A document may legitimately reference a class it does not declare.
  const ontology = loaded.own ?? loaded;
  const scope = loaded.own
    ? scopeOf(loaded)
    : { classes: new Map(loaded.classes.map((c) => [c.id, c])), edges: loaded.edges,
        predicates: new Map((loaded.predicates ?? []).map((p) => [p.predicate, p])) };
  const classes = scope.classes;
  // Predicates whose qualifier is free text authored in the source artefact rather than a term
  // from a fixed vocabulary. A BPMN branch label is written by whoever drew the diagram; warning
  // that the ontology has not seen "Yes - approved" before would fire on every real file.
  const openQualifier = new Set(
    [...(scope.predicates?.values() ?? [])].filter((p) => p.openQualifier).map((p) => p.predicate));
  // The licensing table, keyed by triple. The qualifier rides along because it is the difference
  // between "Business Process uses Data Object" and "Business Process has Requirement".
  const licensed = new Map();
  for (const e of scope.edges) {
    const key = `${e.predicate}|${e.source}|${e.target}`;
    if (!licensed.has(key)) licensed.set(key, []);
    licensed.get(key).push(e);
  }
  // What the ontology does permit between a given pair, so a violation names the fix.
  const between = new Map();
  for (const e of scope.edges) {
    const key = `${e.source}|${e.target}`;
    if (!between.has(key)) between.set(key, new Set());
    between.get(key).add(e.qualifier ? `${e.predicate} («${e.qualifier}»)` : e.predicate);
  }

  if (doc.ontologyVersion !== ontology.schemaVersion) {
    // Fails rather than warns: every check below is meaningless across a version boundary, and
    // running them anyway produces confident findings about the wrong model.
    errors.push(
      `ontologyVersion "${doc.ontologyVersion}" does not match the ontology's schemaVersion ` +
      `"${ontology.schemaVersion}". Nothing below was checked.`);
    return { errors, warnings, metrics: {} };
  }

  const nodes = new Map();
  for (const n of doc.nodes ?? []) {
    if (nodes.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    nodes.set(n.id, n);
    if (!classes.has(n.type)) {
      errors.push(`node "${n.id}" has type "${n.type}", which the ontology does not declare`);
    }
    if ((n.derivation === "inferred" || n.derivation === "decided") && !(n.note && n.evidence)) {
      errors.push(
        `node "${n.id}" is ${n.derivation} and carries no ${n.note ? "evidence" : "note"}. ` +
        `A claim that was not mechanically derived must say why and point at the source.`);
    }
  }

  const byClass = {};
  for (const n of nodes.values()) byClass[n.type] = (byClass[n.type] ?? 0) + 1;

  const byPredicate = {};
  let crossDocument = 0;
  for (const e of doc.edges ?? []) {
    byPredicate[e.predicate] = (byPredicate[e.predicate] ?? 0) + 1;
    const s = nodes.get(e.source) ?? external.get(e.source);
    const t = nodes.get(e.target) ?? external.get(e.target);
    const where = (id) => external.has(id) && !nodes.has(id) ? " (in a sibling document)" : "";
    if (!s) {
      errors.push(`edge ${e.predicate} names source "${e.source}", which is defined in no ` +
                  `document checked in this run`);
      continue;
    }
    if (!t) {
      errors.push(`edge ${e.predicate} names target "${e.target}", which is defined in no ` +
                  `document checked in this run. If it belongs to another layer's document, ` +
                  `pass that file too.`);
      continue;
    }
    if (where(e.source) || where(e.target)) crossDocument++;
    if (!classes.has(s.type) || !classes.has(t.type)) continue; // already reported

    const candidates = licensed.get(`${e.predicate}|${s.type}|${t.type}`);
    if (!candidates) {
      const alt = [...(between.get(`${s.type}|${t.type}`) ?? [])];
      errors.push(
        `edge "${s.type} ${e.predicate} ${t.type}" is not licensed by the ontology. ` +
        (alt.length
          ? `Between those classes the model licenses: ${alt.join(", ")}. ` +
            `An unlicensed edge is usually a missing intermediate node rather than a wrong predicate.`
          : `The model licenses no edge at all between those classes.`));
      continue;
    }
    if (e.qualifier !== undefined && !openQualifier.has(e.predicate)
        && !candidates.some((c) => c.qualifier === e.qualifier)) {
      const known = candidates.map((c) => c.qualifier ?? "(none)").join(", ");
      warnings.push(
        `edge "${s.type} ${e.predicate} ${t.type}" carries qualifier «${e.qualifier}»; ` +
        `the model has: ${known}. More often a model that has moved on than a defect in the graph.`);
    }
    const minEdge = candidates.map((c) => c.minDerivation).find(Boolean);
    if (minEdge && { derived: 0, inferred: 1, decided: 2 }[e.derivation] < { derived: 0, inferred: 1, decided: 2 }[minEdge]) {
      errors.push(`edge "${s.type} ${e.predicate} ${t.type}" is "${e.derivation}", but the model ` +
                  `requires at least "${minEdge}" for it`);
    }
    if (e.derivation === "decided" && !(e.evidence?.by && e.evidence?.at)) {
      errors.push(`edge "${s.type} ${e.predicate} ${t.type}" is "decided" and its evidence does not ` +
                  `say who decided and when (evidence.by, evidence.at)`);
    }
    if ((e.derivation === "inferred" || e.derivation === "decided") && !(e.note && e.evidence)) {
      errors.push(
        `edge "${s.type} ${e.predicate} ${t.type}" is ${e.derivation} and carries no ` +
        `${e.note ? "evidence" : "note"}.`);
    }
  }

  // Property conformance. Each class declares its own permitted property names, so an unknown
  // property is a typo or an invention -- both of which read as data until something rejects them.
  const declared = new Map([...scope.classes.values()].map((c) => [c.id, new Set(c.properties ?? [])]));
  let unchecked = 0;
  for (const n of nodes.values()) {
    const allowed = declared.get(n.type);
    if (!allowed) continue;
    if (!allowed.size) { if (n.properties) unchecked++; continue; }
    for (const key of Object.keys(n.properties ?? {})) {
      if (!allowed.has(key)) {
        errors.push(`node "${n.id}" (${n.type}) has property "${key}", which the class does not declare`);
      }
    }
  }

  // Value conformance. Where a class binds a property to a value set, the value must be one of its
  // codes. Before value sets these vocabularies were prose in a propertyNote, and "Strong",
  // "STRONG" and "weak" all passed -- after which a coverage query filtering on "strong" silently
  // missed two of the three. A binding may be warning-level: an unknown code system is more often a
  // new system than a typo, but a typo breaks every join across guidelines, so it is reported.
  const valueSets = scope.valueSets ?? new Map();
  const codesOf = (id) => (valueSets.get(id)?.codes ?? []).map((c) => c.code);
  for (const n of nodes.values()) {
    const bindings = classes.get(n.type)?.valueSets ?? {};
    for (const [prop, binding] of Object.entries(bindings)) {
      const { set: setId, severity } = bindingOf(binding);
      const value = n.properties?.[prop];
      if (value === undefined || value === null) continue;
      const codes = codesOf(setId);
      if (!codes.includes(value)) {
        (severity === "warning" ? warnings : errors).push(
          `node "${n.id}" (${n.type}) has ${prop} "${value}", which is not a code in ` +
          `value set "${setId}". Permitted: ${codes.join(", ")}`);
      }
    }
    // identifiers is a list of {type, value}; its types are a value set too, and the first usable
    // one builds the publication IRI, so a misspelt type would silently change identity.
    if (Array.isArray(n.properties?.identifiers) && valueSets.has("identifier-type")) {
      for (const idf of n.properties.identifiers) {
        if (!codesOf("identifier-type").includes(idf?.type)) {
          errors.push(`node "${n.id}" has an identifier of type "${idf?.type}", which is not a code ` +
                      `in value set "identifier-type"`);
        }
      }
    }
  }

  // Identity. An L1 IRI is built from what WHO prints -- the publication's ISBN, the recommendation's
  // published number -- so that two extractions of one guideline produce one node rather than two
  // that never join. A node whose IRI does not have its class's shape was minted some other way.
  for (const n of nodes.values()) {
    const pattern = classes.get(n.type)?.iriPattern;
    if (pattern && !new RegExp(pattern).test(n.id)) {
      errors.push(`node "${n.id}" (${n.type}) does not have the IRI shape its class requires ` +
                  `(${pattern}). Mint it with tools/kgid.mjs so re-extraction yields the same node.`);
    }
  }

  // Content hashes. A new PDF hash says something changed; contentHash says what. It must match the
  // stored text, or a re-extraction would compare against a hash of something else.
  for (const n of nodes.values()) {
    const fields = classes.get(n.type)?.contentFields;
    if (!fields) continue;
    const text = contentText(n, fields);
    if (text === null) continue;
    const have = n.properties?.contentHash;
    if (have === undefined) {
      warnings.push(`node "${n.id}" (${n.type}) has no contentHash; a corrected PDF cannot be ` +
                    `checked against it node by node`);
    } else if (have !== contentHash(text)) {
      errors.push(`node "${n.id}" (${n.type}) has a contentHash that does not match its ` +
                  `${fields.join(" + ")}. Recompute it with tools/kgid.mjs contentHash().`);
    }
  }

  // Minimum derivation. Reading a PDF is always a judgement, so content extracted from one is never
  // `derived`; copying a DAK string is mechanical, so a citation may be. A `decided` judgement says
  // who made it and when, because that is what a reviewer asks first.
  const RANK = { derived: 0, inferred: 1, decided: 2 };
  const checkDerivation = (what, item, min) => {
    if (min && RANK[item.derivation] !== undefined && RANK[item.derivation] < RANK[min]) {
      errors.push(`${what} is "${item.derivation}", but the model requires at least "${min}" for it`);
    }
    if (item.derivation === "decided" && !(item.evidence?.by && item.evidence?.at)) {
      errors.push(`${what} is "decided" and its evidence does not say who decided and when ` +
                  `(evidence.by, evidence.at)`);
    }
  };
  for (const n of nodes.values()) {
    checkDerivation(`node "${n.id}"`, n, classes.get(n.type)?.minDerivation);
  }

  const edgesFrom = (id, predicate) => (doc.edges ?? []).filter((e) => e.source === id && e.predicate === predicate);
  const nodeAt = (id) => nodes.get(id) ?? external.get(id);

  // GRADE's rules about which values go together. Grading is optional -- ANC 2016 prints
  // "Recommended" with no strength -- but a strength always needs a direction, a good practice
  // statement is ungraded, and a decision to make no recommendation has nothing to grade.
  for (const n of nodes.values()) {
    if (n.type !== "recommendation") continue;
    const p = n.properties ?? {};
    const kind = p.kind;
    const has = (k) => p[k] !== undefined && p[k] !== null;
    if (has("strength") && !has("direction")) {
      errors.push(`recommendation "${n.id}" carries a strength without a direction. A strength says ` +
                  `how firmly WHO recommends for or against something; record which.`);
    }
    if (kind === "good-practice-statement" || kind === "no-recommendation") {
      const graded = ["strength", "overallCertainty", ...(kind === "no-recommendation" ? ["direction"] : [])]
        .filter(has);
      if (graded.length) {
        errors.push(`recommendation "${n.id}" is kind "${kind}" and carries ${graded.join(", ")}. ` +
                    `${kind === "no-recommendation" ? "No recommendation was made" : "A good practice statement is ungraded"}` +
                    `, so there is nothing to grade.`);
      }
    }

    // Recommendations come from GRC-approved guidelines. Unrecorded approval is a warning -- real
    // consolidated guidelines do not always state it -- and a recorded "not-reviewed" is an error.
    for (const e of edgesFrom(n.id, "definedIn")) {
      const pub = nodeAt(e.target);
      const grc = pub?.properties?.grcStatus;
      if (grc === "not-reviewed") {
        errors.push(`recommendation "${n.id}" is defined in "${e.target}", which is recorded as not ` +
                    `reviewed by the GRC. Recommendations come from GRC-approved guidelines.`);
      } else if (pub && grc === undefined) {
        warnings.push(`recommendation "${n.id}" is defined in "${e.target}", which records no GRC status`);
      }
    }

    // Slots quote the source. A slot that appears in neither the statement, its remarks, nor the
    // caption or heading it is printed under was written by the extractor, not by WHO.
    const sources = [p.statement ?? ""];
    for (const e of edgesFrom(n.id, "hasRemark")) sources.push(nodeAt(e.target)?.properties?.text ?? "");
    for (const e of edgesFrom(n.id, "presentedIn")) {
      const where = nodeAt(e.target)?.properties ?? {};
      sources.push(where.caption ?? "", where.heading ?? "");
      for (const up of (doc.edges ?? []).filter((x) => x.predicate === "contains" && x.target === e.target)) {
        const parent = nodeAt(up.source)?.properties ?? {};
        sources.push(parent.caption ?? "", parent.heading ?? "");
      }
    }
    const haystack = norm(sources.join(" \n "));
    for (const slot of ["intervention", "population", "setting", "provider", "timing"]) {
      if (has(slot) && !haystack.includes(norm(p[slot]))) {
        warnings.push(`recommendation "${n.id}" has ${slot} "${p[slot]}", which is not quoted from its ` +
                      `statement, remarks, or the caption or heading it is printed under`);
      }
    }

    // Overall certainty is the lowest across critical outcomes (handbook §9.6). Stating something
    // higher is usually a transcription error; the handbook allows exceptions, so this warns.
    if (has("overallCertainty")) {
      const ORDER = ["very-low", "low", "moderate", "high"];
      const critical = [];
      for (const s of edgesFrom(n.id, "supportedBy")) {
        const ev = nodeAt(s.target);
        if (!ev?.properties?.certainty) continue;
        for (const f of edgesFrom(s.target, "forOutcome")) {
          if (nodeAt(f.target)?.properties?.importance === "critical") critical.push(ev.properties.certainty);
        }
      }
      if (critical.length) {
        const lowest = critical.reduce((a, b) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b));
        if (ORDER.indexOf(p.overallCertainty) > ORDER.indexOf(lowest)) {
          warnings.push(`recommendation "${n.id}" states overallCertainty "${p.overallCertainty}", higher ` +
                        `than the lowest certainty on its critical outcomes ("${lowest}"; handbook §9.6)`);
        }
      }
    }
  }

  // One copy of the words. A table row whose column is filled from a content node through the
  // table's columnMap must not store that cell again; two copies drift apart.
  for (const n of nodes.values()) {
    if (n.type !== "publication-element" || n.properties?.elementType !== "table") continue;
    const { columns, columnMap } = n.properties;
    if (!Array.isArray(columns) || !columnMap) continue;
    const mapped = columns.map((c, i) => (columnMap[c] ? i : -1)).filter((i) => i >= 0);
    for (const e of edgesFrom(n.id, "contains")) {
      const row = nodeAt(e.target);
      if (row?.properties?.rowType !== "data" || !Array.isArray(row.properties.cells)) continue;
      const presented = (doc.edges ?? []).some((x) => x.predicate === "presentedIn" && x.target === row.id);
      for (const i of mapped) {
        if (presented && row.properties.cells[i] !== null && row.properties.cells[i] !== undefined) {
          errors.push(`row "${row.id}" stores column "${columns[i]}", which the table fills from ` +
                      `${columnMap[columns[i]]} of the content presented there. Store it once: set the cell to null.`);
        }
      }
    }
  }

  // A citation that claims to be resolved must actually resolve -- directly, or through the
  // reference-list entry its "(n)" points at. A placeholder never resolves: "[Add appropriate
  // reference]" is the author saying a source is missing, and resolving it would invent one.
  const resolved = (id, seen = new Set()) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (edgesFrom(id, "resolvesTo").length) return true;
    return edgesFrom(id, "numberedAs").some((e) =>
      nodeAt(e.target)?.properties?.resolutionStatus === "resolved" && resolved(e.target, seen));
  };
  for (const n of nodes.values()) {
    if (n.type !== "citation" && n.type !== "reference-entry") continue;
    const status = n.properties?.resolutionStatus;
    const direct = edgesFrom(n.id, "resolvesTo").length > 0;
    if (n.type === "citation" && n.properties?.citationKind === "placeholder") {
      if (direct || status === "resolved") {
        errors.push(`citation "${n.id}" is a placeholder and claims a resolution. A placeholder marks ` +
                    `a missing source; it never resolves.`);
      }
    } else if (status === "resolved" && !resolved(n.id)) {
      errors.push(`${n.type} "${n.id}" claims resolutionStatus "resolved" but has no resolvesTo edge`);
    }
    if (direct && status !== "resolved") {
      warnings.push(`${n.type} "${n.id}" has a resolvesTo edge but resolutionStatus is "${status}"`);
    }
    if (!n.properties?.text) {
      errors.push(`${n.type} "${n.id}" carries no verbatim text, so nothing can be checked against the source`);
    }
  }

  // The same discipline for every cross-format join. L2's three joins are string equality across
  // file formats, and an edge that claims `resolved` while its target is itself marked unresolved
  // is a match asserted against a thing that was never found.
  // One vocabulary for nodes and edges: the L1 value set when it is in scope, which it is for every
  // layer, since all of them import L1.
  const RESOLVABLE = new Set(valueSets.has("resolution-status")
    ? codesOf("resolution-status") : ["unresolved", "resolved", "ambiguous"]);
  const joins = { resolved: 0, unresolved: 0, ambiguous: 0 };
  for (const e of doc.edges ?? []) {
    const status = e.properties?.resolutionStatus;
    if (status === undefined) continue;
    if (!RESOLVABLE.has(status)) {
      errors.push(`edge "${e.predicate}" carries resolutionStatus "${status}"; ` +
                  `permitted values are ${[...RESOLVABLE].join(", ")}`);
      continue;
    }
    joins[status]++;
    if (status !== "resolved") continue;
    const t = nodes.get(e.target) ?? external.get(e.target);
    if (t && t.properties?.resolutionStatus && t.properties.resolutionStatus !== "resolved") {
      errors.push(
        `edge "${e.predicate}" claims resolutionStatus "resolved" but its target "${e.target}" ` +
        `is itself "${t.properties.resolutionStatus}". A join cannot be resolved against a ` +
        `placeholder.`);
    }
    if ((e.derivation === "inferred" || e.derivation === "decided") && !e.evidence?.location) {
      errors.push(
        `edge "${e.predicate}" claims a resolved match but points at no evidence. A match made ` +
        `by string equality must say which file and which line it was made against.`);
    }
  }

  return {
    errors,
    warnings,
    // Reported pass or fail. The failure this guards against does not look like an error: a
    // misconfigured extract exits clean with a plausible document and implausible numbers behind it.
    metrics: {
      nodes: nodes.size,
      edges: (doc.edges ?? []).length,
      byClass,
      byPredicate,
      ...(joins.resolved + joins.unresolved + joins.ambiguous ? { joins } : {}),
      ...(crossDocument ? { crossDocumentEdges: crossDocument } : {}),
      ...(unchecked ? { nodesWithUndeclaredShape: unchecked } : {}),
    },
  };
}

function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!files.length) {
    // This repository holds the schema and no data, so there is nothing to check by default.
    // Pass the documents to check; several at once resolves references that cross layers.
    console.error("usage: validate.mjs <graph-document.json>...");
    console.error("  Several documents may be given together; a reference from one to another");
    console.error("  resolves across the set, which is how a graph split across layers is checked.");
    process.exit(2);
  }

  // Every document in the run, indexed before any is checked. Documents of different layers
  // reference each other by IRI and neither is complete alone.
  const parsed = files.map((file) => ({ file, doc: JSON.parse(readFileSync(file, "utf8")) }));

  const cache = new Map();
  const layerFor = (name) => {
    if (!cache.has(name)) cache.set(name, loadLayer(name));
    return cache.get(name);
  };

  // Building that index is where the layering mechanism gets checked. One artefact keeps one
  // address across layers: the L1 document describes a DMN file as an opaque external-artifact and
  // the L2 document describes the same file, at the same IRI, as a decision-table. That is
  // intended and is declared by `elaborates` on the L2 class. Any OTHER pair of types sharing one
  // IRI is two different things claiming one address, which no store can reconcile.
  const everyNode = new Map();
  const elaborations = [];
  let failed = false;
  // Which class elaborates which, across every layer in the run -- collected before any node is
  // compared, because files arrive in name order and l2-dmn.json sorts before l2.json. Built per
  // document, an L2 file meeting a DMN file's IRI could not see that dmn-definitions elaborates
  // external-artifact, and reported one artefact as two things.
  const elaboratesOf = new Map();
  for (const { doc } of parsed) {
    try {
      for (const c of scopeOf(layerFor(layerOf(doc))).classes.values()) {
        if (c.elaborates) elaboratesOf.set(c.id, c.elaborates);
      }
    } catch { /* reported per document below */ }
  }
  for (const { file, doc } of parsed) {
    for (const n of doc.nodes ?? []) {
      const prior = everyNode.get(n.id);
      if (!prior) { everyNode.set(n.id, n); continue; }
      if (prior.type === n.type) continue;
      if (elaboratesOf.get(n.type) === prior.type) {
        elaborations.push(`${n.id}\n      ${prior.type} (opaque) elaborated as ${n.type}`);
        everyNode.set(n.id, n);            // the more specific description wins
      } else if (elaboratesOf.get(prior.type) === n.type) {
        elaborations.push(`${n.id}\n      ${n.type} (opaque) elaborated as ${prior.type}`);
      } else {
        console.error(
          `  error: ${relative(ROOT, file)} defines "${n.id}" as ${n.type}, but another document ` +
          `defines it as ${prior.type}, and neither class declares it elaborates the other. ` +
          `One IRI names one thing.`);
        failed = true;
      }
    }
  }
  if (elaborations.length) {
    console.log(`${elaborations.length} artefact(s) described at two layers under one IRI:`);
    for (const e of elaborations) console.log(`    ${e}`);
    console.log("");
  }

  for (const { file, doc } of parsed) {
    const layer = layerOf(doc);
    const name = relative(ROOT, file);
    let loaded;
    try {
      loaded = layerFor(layer);
    } catch (err) {
      console.error(`${name}: ${err.message}`);
      failed = true;
      continue;
    }
    const { errors, warnings, metrics } = validateGraph(doc, loaded, everyNode);
    console.log(
      `${name} [${layer}${loaded.imported.layers.length ? ` + ${loaded.imported.layers.join(", ")}` : ""}]: ` +
      `${metrics.nodes} nodes, ${metrics.edges} edges ` +
      `[${Object.entries(metrics.byClass).map(([k, v]) => `${k}:${v}`).join(" ")}]`);
    if (metrics.crossDocumentEdges) {
      console.log(`  ${metrics.crossDocumentEdges} edge(s) reach a node defined in a sibling document`);
    }
    if (metrics.joins) {
      console.log(`  cross-format joins: ${metrics.joins.resolved} resolved, ` +
                  `${metrics.joins.unresolved} unresolved, ${metrics.joins.ambiguous} ambiguous`);
    }
    for (const w of warnings) console.warn(`  warning: ${w}`);
    for (const e of errors) { console.error(`  error: ${e}`); failed = true; }
    if (!errors.length) console.log("  conforms to the ontology");
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
