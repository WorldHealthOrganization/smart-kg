#!/usr/bin/env node
// Checks an L1 graph document against the L1 ontology -- tier 2.
//
// Tier 1 is shape: does the document match shapes/dak-kg.schema.json. That is a JSON Schema
// question and CI answers it with ajv. This answers the question a JSON Schema cannot: are the
// node types classes the ontology declares, and is every edge a triple the ArchiMate model
// licenses. Inlining 191 licensed triples into a schema would have forked the ArchiMate model;
// checking the model as data is the alternative, and this is it.
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ONTOLOGY = join(ROOT, "ontology", "l1.json");
const EXAMPLES = join(ROOT, "examples");

/**
 * @returns {{errors: string[], warnings: string[], metrics: object}}
 */
export function validateGraph(doc, ontology) {
  const errors = [];
  const warnings = [];

  const classes = new Map(ontology.classes.map((c) => [c.id, c]));
  // The licensing table, keyed by triple. The qualifier rides along because it is the difference
  // between "Business Process uses Data Object" and "Business Process has Requirement".
  const licensed = new Map();
  for (const e of ontology.edges) {
    const key = `${e.predicate}|${e.source}|${e.target}`;
    if (!licensed.has(key)) licensed.set(key, []);
    licensed.get(key).push(e);
  }
  // What the ontology does permit between a given pair, so a violation names the fix.
  const between = new Map();
  for (const e of ontology.edges) {
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
  for (const e of doc.edges ?? []) {
    byPredicate[e.predicate] = (byPredicate[e.predicate] ?? 0) + 1;
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    if (!s) { errors.push(`edge ${e.predicate} names source "${e.source}", which is not a node here`); continue; }
    if (!t) { errors.push(`edge ${e.predicate} names target "${e.target}", which is not a node here`); continue; }
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
    if (e.qualifier !== undefined && !candidates.some((c) => c.qualifier === e.qualifier)) {
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
  const declared = new Map(ontology.classes.map((c) => [c.id, new Set(c.properties ?? [])]));
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
      ...(unchecked ? { nodesWithUndeclaredShape: unchecked } : {}),
    },
  };
}

function main() {
  if (!existsSync(ONTOLOGY)) {
    console.error(`${relative(ROOT, ONTOLOGY)} is missing.`);
    process.exit(1);
  }
  const ontology = JSON.parse(readFileSync(ONTOLOGY, "utf8"));

  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const files = args.length
    ? args
    : readdirSync(EXAMPLES).filter((f) => f.endsWith(".json")).map((f) => join(EXAMPLES, f));

  if (!files.length) {
    console.error("no graph documents to check");
    process.exit(1);
  }

  let failed = false;
  for (const file of files) {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const { errors, warnings, metrics } = validateGraph(doc, ontology);
    const name = relative(ROOT, file);
    console.log(
      `${name}: ${metrics.nodes} nodes, ${metrics.edges} edges ` +
      `[${Object.entries(metrics.byClass).map(([k, v]) => `${k}:${v}`).join(" ")}]`);
    for (const w of warnings) console.warn(`  warning: ${w}`);
    for (const e of errors) { console.error(`  error: ${e}`); failed = true; }
    if (!errors.length) console.log("  conforms to the ontology");
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
