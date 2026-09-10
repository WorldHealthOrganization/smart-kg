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
//   node tools/validate.mjs                    # every examples/*.kg.json
//   node tools/validate.mjs path/to/graph.json
//
// Plain Node, no dependencies.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLayer, scopeOf } from "./ontology.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(ROOT, "examples");
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

  // A citation that claims to be resolved must actually resolve to something. This is the check the
  // repository exists for: an unresolved citation is the honest state, and a resolved one that
  // points nowhere is worse than no link at all.
  for (const n of nodes.values()) {
    if (n.type !== "citation") continue;
    const status = n.properties?.resolutionStatus;
    const resolves = (doc.edges ?? []).some((e) => e.predicate === "resolvesTo" && e.source === n.id);
    if (status === "resolved" && !resolves) {
      errors.push(`citation "${n.id}" claims resolutionStatus "resolved" but has no resolvesTo edge`);
    }
    if (resolves && status !== "resolved") {
      warnings.push(`citation "${n.id}" has a resolvesTo edge but resolutionStatus is "${status}"`);
    }
    if (!n.properties?.text) {
      errors.push(`citation "${n.id}" carries no verbatim text, so nothing can be checked against the source`);
    }
  }

  // The same discipline for every cross-format join. L2's three joins are string equality across
  // file formats, and an edge that claims `resolved` while its target is itself marked unresolved
  // is a match asserted against a thing that was never found.
  const RESOLVABLE = new Set(["unresolved", "resolved", "ambiguous"]);
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
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const files = args.length
    ? args
    : readdirSync(EXAMPLES).filter((f) => f.endsWith(".json")).map((f) => join(EXAMPLES, f));

  if (!files.length) {
    console.error("no graph documents to check");
    process.exit(1);
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
  for (const { file, doc } of parsed) {
    let elaboratesOf;
    try {
      elaboratesOf = new Map(
        [...scopeOf(layerFor(layerOf(doc))).classes.values()]
          .filter((c) => c.elaborates).map((c) => [c.id, c.elaborates]));
    } catch { elaboratesOf = new Map(); }   // reported per document below
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
